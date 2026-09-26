// Datenmodell der Inbox: Schema, Migration, Merge, Sortierung, Fälligkeiten.
// Bewusst ohne React und ohne Imports, damit es mit `node --test` direkt
// (Type-Stripping) testbar bleibt.

export type Kind = "Aufgabe" | "Termin" | "Notiz" | "Idee";
export const KINDS: Kind[] = ["Aufgabe", "Termin", "Notiz", "Idee"];

// `dueAt` ist entweder ein Datum ("2026-10-12", ganztägig) oder ein ISO-
// Zeitstempel mit Uhrzeit. `created` ist das Anzeige-Label aus Schema v1 und
// bleibt nur für Altbestände erhalten.
export type Entry = {
  id: string;
  kind: Kind;
  text: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  done?: boolean;
  dueAt?: string;
  created?: string;
};

export function classify(text: string): Kind {
  const value = text.toLowerCase();
  if (/morgen|uhr|termin|treffen|montag|dienstag|mittwoch|donnerstag|freitag|cita|reunión|reunion|mañana|lunes|martes|miércoles|miercoles|jueves|viernes/.test(value)) return "Termin";
  if (/muss|erledigen|machen|aufgabe|todo|erinner|tengo que|tarea|pagar/.test(value)) return "Aufgabe";
  if (/idee|vielleicht|könnte|vorschlag|idea|quizás|quizas|podría|podria/.test(value)) return "Idee";
  return "Notiz";
}

export function createEntry(text: string, now = new Date()): Entry {
  const stamp = now.toISOString();
  return { id: crypto.randomUUID(), kind: classify(text), text, createdAt: stamp, updatedAt: stamp, dueAt: parseDue(text, now) };
}

type RawEntry = Partial<Entry> & { title?: string; detail?: string };

// Bringt Einträge aus jedem bisherigen Format (v1 mit title/detail, v1 ohne
// Zeitstempel, Import-Dateien, Server-Payloads) auf das aktuelle Schema.
// Liefert null für unbrauchbare Datensätze.
export function normalizeEntry(raw: unknown, fallbackStamp: string): Entry | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as RawEntry;
  const text = typeof item.text === "string" ? item.text : [item.title, item.detail && !item.detail.startsWith("Automatisch lokal erkannt") ? item.detail : ""].filter(Boolean).join("\n");
  if (!text) return null;
  const updatedAt = isIso(item.updatedAt) ? item.updatedAt : fallbackStamp;
  const entry: Entry = {
    id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
    kind: KINDS.includes(item.kind as Kind) ? (item.kind as Kind) : classify(text),
    text,
    createdAt: isIso(item.createdAt) ? item.createdAt : updatedAt,
    updatedAt,
  };
  if (isIso(item.deletedAt)) entry.deletedAt = item.deletedAt;
  if (item.done === true) entry.done = true;
  if (typeof item.dueAt === "string" && (isIso(item.dueAt) || isDateOnly(item.dueAt))) entry.dueAt = item.dueAt;
  if (typeof item.created === "string" && !isIso(item.createdAt)) entry.created = item.created;
  return entry;
}

export function normalizeEntries(raw: unknown, fallbackStamp = new Date().toISOString()): Entry[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { entries?: unknown }).entries) ? (raw as { entries: unknown[] }).entries : [];
  return list.map((item) => normalizeEntry(item, fallbackStamp)).filter((entry): entry is Entry => entry !== null);
}

// Last-writer-wins pro id über `updatedAt`. Tombstones (deletedAt) gewinnen
// genauso, damit Gelöschtes nicht wiederkommt. Ergebnis: neueste zuerst.
export function mergeEntries(local: Entry[], remote: Entry[]): Entry[] {
  const merged = new Map<string, Entry>();
  [...local, ...remote].forEach((entry) => {
    const current = merged.get(entry.id);
    if (!current || entry.updatedAt > current.updatedAt) merged.set(entry.id, entry);
  });
  return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Gelöschte Einträge länger als `days` vergessen, damit der Bestand nicht
// unbegrenzt wächst. Der Server behält seine Kopie ohnehin.
export function purgeTombstones(entries: Entry[], now = new Date(), days = 90): Entry[] {
  const limit = new Date(now.getTime() - days * 86_400_000).toISOString();
  return entries.filter((entry) => !entry.deletedAt || entry.deletedAt > limit);
}

// Anzeige-Reihenfolge: offene vor erledigten; unter den offenen fällige
// (früheste zuerst) vor den übrigen (neueste zuerst); Erledigte zuletzt
// erledigt oben.
export function sortForDisplay(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    if (a.done) return b.updatedAt.localeCompare(a.updatedAt);
    if (a.dueAt && b.dueAt) return dueTime(a.dueAt) - dueTime(b.dueAt) || b.createdAt.localeCompare(a.createdAt);
    if (a.dueAt || b.dueAt) return a.dueAt ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

// Neuester Eintrag (optional einer Kategorie) – für "lösch die letzte Notiz".
export function latestEntry(entries: Entry[], kind: Kind | null): Entry | null {
  const pick = (list: Entry[]) => list.reduce<Entry | null>((best, entry) => (!best || entry.createdAt > best.createdAt ? entry : best), null);
  const active = entries.filter((entry) => !entry.deletedAt);
  return (kind && pick(active.filter((entry) => entry.kind === kind))) || pick(active);
}

// ---------------------------------------------------------------------------
// Zeitangaben
// ---------------------------------------------------------------------------

function isIso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}
function isDateOnly(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function pad(value: number) {
  return String(value).padStart(2, "0");
}
export function toDateKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function fromDateKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}
function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
function addDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes());
}
// Ganztägige Fälligkeiten zählen bis zum Tagesende, sortieren aber vor
// terminierten Einträgen desselben Tages.
function dueTime(dueAt: string) {
  return isDateOnly(dueAt) ? fromDateKey(dueAt).getTime() : Date.parse(dueAt);
}

const WEEKDAYS: Array<[RegExp, number]> = [
  [/\b(sonntags?|sunday)\b|\bdomingo\b/, 0],
  [/\b(montags?|monday)\b|\blunes\b/, 1],
  [/\b(dienstags?|tuesday)\b|\bmartes\b/, 2],
  [/\b(mittwochs?|wednesday)\b|\bmi[ée]rcoles(?![a-z])/, 3],
  [/\b(donnerstags?|thursday)\b|\bjueves\b/, 4],
  [/\b(freitags?|friday)\b|\bviernes\b/, 5],
  [/\b(samstags?|sonnabends?|saturday)\b|\bs[áa]bado(?![a-z])/, 6],
];

// Erkennt Fälligkeiten in DE/EN/ES – deterministisch und offline:
// "morgen 15 Uhr", "übermorgen", "am Freitag", "12.10.", "um 9:30",
// "in 3 Tagen", "nächste Woche", "tomorrow at 3pm", "mañana a las 10".
// Liefert "YYYY-MM-DD" (ganztägig), einen ISO-Zeitstempel oder undefined.
export function parseDue(text: string, now = new Date()): string | undefined {
  const q = text.toLowerCase();
  let day: Date | null = null;

  const date = q.match(/(?:^|[^\d.])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?![\d])/);
  if (date) {
    const [, d, m, y] = date;
    const year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : now.getFullYear();
    const candidate = new Date(year, Number(m) - 1, Number(d));
    if (candidate.getMonth() === Number(m) - 1 && candidate.getDate() === Number(d)) {
      day = !y && candidate < startOfDay(now) ? new Date(year + 1, Number(m) - 1, Number(d)) : candidate;
    }
  }
  if (!day) {
    const inDays = q.match(/\bin (\d{1,3}|einem|zwei|drei|vier|fünf|a|one|two|three|un|dos|tres) (tag(?:en)?|days?|d[íi]as?|wochen?|weeks?|semanas?)\b/);
    const words: Record<string, number> = { einem: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, a: 1, one: 1, two: 2, three: 3, un: 1, dos: 2, tres: 3 };
    if (inDays) {
      const count = words[inDays[1]] ?? Number(inDays[1]);
      day = addDays(startOfDay(now), /woche|week|semana/.test(inDays[2]) ? count * 7 : count);
    } else if (/übermorgen|pasado mañana/.test(q)) day = addDays(startOfDay(now), 2);
    else if (/(?<!guten )\bmorgen\b|\btomorrow\b|(?:^|\s)mañana(?!\S)(?<!(?:la|esta|de) mañana)/.test(q)) day = addDays(startOfDay(now), 1);
    else if (/\bheute\b|\btoday\b|\bhoy\b|\btonight\b|\bheute abend\b/.test(q)) day = startOfDay(now);
    else if (/\bnächste[nr]? woche\b|\bnext week\b|\bla (semana|pr[óo]xima semana) que viene\b|\bpr[óo]xima semana\b/.test(q)) day = addDays(startOfDay(now), 7);
    else {
      const weekday = WEEKDAYS.find(([pattern]) => pattern.test(q));
      if (weekday) {
        const diff = (weekday[1] - now.getDay() + 7) % 7 || 7;
        day = addDays(startOfDay(now), diff);
      }
    }
  }

  let hours: number | null = null;
  let minutes = 0;
  const clock = q.match(/\b(\d{1,2})[:.](\d{2})\s*(?:uhr|h)\b/) ?? q.match(/\b(\d{1,2}):(\d{2})\b/);
  const ampm = q.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  const uhr = q.match(/\b(\d{1,2})\s*uhr\b/);
  const um = q.match(/\b(?:um|at|a las?)\s+(\d{1,2})(?::(\d{2}))?\b(?![.:]\d)/);
  if (ampm) {
    hours = (Number(ampm[1]) % 12) + (ampm[3] === "pm" ? 12 : 0);
    minutes = Number(ampm[2] ?? 0);
  } else if (clock) {
    hours = Number(clock[1]);
    minutes = Number(clock[2]);
  } else if (uhr) {
    hours = Number(uhr[1]);
  } else if (um) {
    hours = Number(um[1]);
    minutes = Number(um[2] ?? 0);
  }
  if (hours !== null && (hours > 23 || minutes > 59)) hours = null;

  if (hours === null) return day ? toDateKey(day) : undefined;
  let at = new Date((day ?? now).getFullYear(), (day ?? now).getMonth(), (day ?? now).getDate(), hours, minutes);
  // Nur eine Uhrzeit, die heute schon vorbei ist -> morgen.
  if (!day && at <= now) at = addDays(at, 1);
  return at.toISOString();
}

export type DueState = "overdue" | "today" | "upcoming";

export function dueState(dueAt: string, now = new Date()): DueState {
  if (isDateOnly(dueAt)) {
    const today = toDateKey(now);
    return dueAt < today ? "overdue" : dueAt === today ? "today" : "upcoming";
  }
  const at = new Date(dueAt);
  if (at < now) return "overdue";
  return toDateKey(at) === toDateKey(now) ? "today" : "upcoming";
}

const relativeDays = new Intl.RelativeTimeFormat("de", { numeric: "auto" });

export function formatDue(dueAt: string, now = new Date()): string {
  const dateOnly = isDateOnly(dueAt);
  const at = dateOnly ? fromDateKey(dueAt) : new Date(dueAt);
  const diff = Math.round((startOfDay(at).getTime() - startOfDay(now).getTime()) / 86_400_000);
  const dayLabel = Math.abs(diff) <= 2
    ? capitalize(relativeDays.format(diff, "day"))
    : at.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "numeric", ...(at.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return dateOnly ? dayLabel : `${dayLabel}, ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function formatCreated(entry: Pick<Entry, "createdAt" | "created">, now = new Date()): string {
  if (entry.created && entry.created !== "Gerade eben") return entry.created;
  const seconds = Math.round((Date.parse(entry.createdAt) - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return "Gerade eben";
  if (abs < 3600) return capitalize(relativeDays.format(Math.round(seconds / 60), "minute"));
  if (abs < 86_400) return capitalize(relativeDays.format(Math.round(seconds / 3600), "hour"));
  if (abs < 7 * 86_400) return capitalize(relativeDays.format(Math.round(seconds / 86_400), "day"));
  return new Date(entry.createdAt).toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" });
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Wert für <input type="datetime-local"> bzw. zurück in ein dueAt.
export function dueToInput(dueAt: string | undefined): string {
  if (!dueAt) return "";
  if (isDateOnly(dueAt)) return `${dueAt}T09:00`;
  const at = new Date(dueAt);
  return `${toDateKey(at)}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
export function inputToDue(value: string): string | undefined {
  if (!value) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}
// Wiedervorlage: Fälligkeit um n Tage verschieben (ab heute, falls überfällig).
export function snoozeDue(dueAt: string | undefined, days: number, now = new Date()): string {
  if (!dueAt || isDateOnly(dueAt)) {
    const base = dueAt && dueAt >= toDateKey(now) ? fromDateKey(dueAt) : startOfDay(now);
    return toDateKey(addDays(base, days));
  }
  const at = new Date(dueAt);
  const base = at < now ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), at.getHours(), at.getMinutes()) : at;
  return addDays(base, days).toISOString();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function toMarkdown(entries: Entry[], now = new Date()): string {
  const lines = [`# Voice Inbox`, "", `Exportiert am ${now.toLocaleString("de-DE")}`, ""];
  for (const kind of KINDS) {
    const group = sortForDisplay(entries.filter((entry) => entry.kind === kind && !entry.deletedAt));
    if (!group.length) continue;
    lines.push(`## ${kind}`, "");
    for (const entry of group) {
      const [first, ...rest] = entry.text.split("\n");
      const due = entry.dueAt ? ` _(fällig: ${formatDue(entry.dueAt, now)})_` : "";
      lines.push(`- [${entry.done ? "x" : " "}] ${first}${due}`, ...rest.map((line) => `  ${line}`));
    }
    lines.push("");
  }
  return lines.join("\n");
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDue, dueState, formatDue, formatCreated, mergeEntries, normalizeEntries, sortForDisplay, latestEntry, purgeTombstones, snoozeDue, toMarkdown, type Entry } from "../app/inbox/model.ts";

// Samstag, 26.09.2026, 10:00 Ortszeit
const now = new Date(2026, 8, 26, 10, 0);
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

test("parseDue erkennt relative Tage und Uhrzeiten", () => {
  assert.equal(parseDue("Termin morgen um 15 Uhr beim Zahnarzt", now), local(2026, 9, 27, 15));
  assert.equal(parseDue("übermorgen Müll rausbringen", now), "2026-09-28");
  assert.equal(parseDue("heute noch anrufen", now), "2026-09-26");
  assert.equal(parseDue("Meeting um 9:30", now), local(2026, 9, 27, 9, 30)); // 9:30 schon vorbei -> morgen
  assert.equal(parseDue("Call 14.15 Uhr", now), local(2026, 9, 26, 14, 15));
  assert.equal(parseDue("in 3 Tagen Paket abholen", now), "2026-09-29");
  assert.equal(parseDue("nächste Woche Steuer", now), "2026-10-03");
});

test("parseDue erkennt Wochentage und Datumsangaben", () => {
  assert.equal(parseDue("am Montag Bericht abgeben", now), "2026-09-28");
  assert.equal(parseDue("Samstag Markt", now), "2026-10-03"); // heute Samstag -> nächste Woche
  assert.equal(parseDue("Geburtstag am 12.10.", now), "2026-10-12");
  assert.equal(parseDue("Frist 3.1.", now), "2027-01-03"); // schon vorbei -> nächstes Jahr
  assert.equal(parseDue("Vertrag bis 31.12.2027", now), "2027-12-31");
  assert.equal(parseDue("Arzt am 12.10. um 8 Uhr", now), local(2026, 10, 12, 8));
});

test("parseDue versteht Englisch und Spanisch", () => {
  assert.equal(parseDue("call mom tomorrow at 3pm", now), local(2026, 9, 27, 15));
  assert.equal(parseDue("cita mañana a las 10", now), local(2026, 9, 27, 10));
  assert.equal(parseDue("el viernes reunión", now), "2026-10-02");
});

test("parseDue bleibt bei normalem Text stumm", () => {
  for (const text of ["Buchtipp von Anna", "Idee für ein neues Projekt", "Guten Morgen notieren", "Version 2.5 testen", "por la mañana correr"]) {
    assert.equal(parseDue(text, now), undefined, text);
  }
});

test("dueState und formatDue", () => {
  assert.equal(dueState("2026-09-25", now), "overdue");
  assert.equal(dueState("2026-09-26", now), "today");
  assert.equal(dueState(local(2026, 9, 26, 9), now), "overdue");
  assert.equal(dueState(local(2026, 9, 26, 18), now), "today");
  assert.equal(dueState("2026-09-27", now), "upcoming");
  assert.equal(formatDue("2026-09-27", now), "Morgen");
  assert.equal(formatDue(local(2026, 9, 26, 18, 5), now), "Heute, 18:05");
});

test("formatCreated nutzt echte Zeitstempel", () => {
  assert.equal(formatCreated({ createdAt: new Date(now.getTime() - 20_000).toISOString() }, now), "Gerade eben");
  assert.equal(formatCreated({ createdAt: new Date(now.getTime() - 5 * 60_000).toISOString() }, now), "Vor 5 Minuten");
  assert.equal(formatCreated({ createdAt: new Date(now.getTime() - 26 * 3600_000).toISOString() }, now), "Gestern");
  assert.match(formatCreated({ createdAt: new Date(2026, 0, 3).toISOString() }, now), /2026/);
  assert.equal(formatCreated({ createdAt: now.toISOString(), created: "Importiert" }, now), "Importiert");
});

test("normalizeEntries migriert v1-Bestände verlustfrei", () => {
  const stamp = "2026-09-26T08:00:00.000Z";
  const entries = normalizeEntries([
    { id: "a", kind: "Idee", title: "Titel", detail: "Details" },
    { id: "b", kind: "Quatsch", text: "Ich muss los", created: "Gerade eben", updatedAt: "2026-09-01T10:00:00.000Z" },
    { text: "" },
    null,
  ], stamp);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { id: "a", kind: "Idee", text: "Titel\nDetails", createdAt: stamp, updatedAt: stamp });
  assert.equal(entries[1].kind, "Aufgabe");
  assert.equal(entries[1].createdAt, "2026-09-01T10:00:00.000Z");
  assert.equal(normalizeEntries({ entries: [{ id: "x", text: "Hallo" }] }, stamp).length, 1);
});

const entry = (id: string, patch: Partial<Entry> = {}): Entry => ({ id, kind: "Notiz", text: id, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...patch });

test("mergeEntries: neuere Version und Tombstones gewinnen", () => {
  const merged = mergeEntries(
    [entry("a", { text: "lokal alt" }), entry("b", { deletedAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z" })],
    [entry("a", { text: "remote neu", updatedAt: "2026-09-02T00:00:00.000Z" }), entry("b"), entry("c")],
  );
  assert.equal(merged.length, 3);
  assert.equal(merged.find((e) => e.id === "a")?.text, "remote neu");
  assert.ok(merged.find((e) => e.id === "b")?.deletedAt);
});

test("sortForDisplay: fällig zuerst, erledigt zuletzt", () => {
  const sorted = sortForDisplay([
    entry("alt", { createdAt: "2026-09-01T00:00:00.000Z" }),
    entry("neu", { createdAt: "2026-09-20T00:00:00.000Z" }),
    entry("fertig", { done: true }),
    entry("spaeter", { dueAt: "2026-10-10" }),
    entry("bald", { dueAt: "2026-09-27T08:00:00.000Z" }),
  ]);
  assert.deepEqual(sorted.map((e) => e.id), ["bald", "spaeter", "neu", "alt", "fertig"]);
});

test("latestEntry, purgeTombstones, snoozeDue", () => {
  const list = [entry("a", { createdAt: "2026-09-02T00:00:00.000Z", kind: "Idee" }), entry("b", { createdAt: "2026-09-03T00:00:00.000Z" }), entry("c", { createdAt: "2026-09-04T00:00:00.000Z", deletedAt: "2026-09-04T00:00:00.000Z" })];
  assert.equal(latestEntry(list, null)?.id, "b");
  assert.equal(latestEntry(list, "Idee")?.id, "a");
  assert.equal(latestEntry(list, "Termin")?.id, "b");
  assert.equal(purgeTombstones(list, new Date("2027-01-01T00:00:00.000Z")).length, 2);
  assert.equal(snoozeDue("2026-09-20", 1, now), "2026-09-27");
  assert.equal(snoozeDue(undefined, 7, now), "2026-10-03");
  assert.equal(snoozeDue(local(2026, 9, 25, 8), 1, now), local(2026, 9, 27, 8));
});

test("toMarkdown gliedert nach Kategorie mit Checkboxen", () => {
  const md = toMarkdown([entry("x", { kind: "Aufgabe", text: "Rechnung\nbis Freitag", done: true }), entry("y", { kind: "Idee", text: "App bauen" }), entry("z", { deletedAt: "2026-09-02T00:00:00.000Z" })], now);
  assert.match(md, /## Aufgabe\n\n- \[x\] Rechnung\n {2}bis Freitag/);
  assert.match(md, /## Idee\n\n- \[ \] App bauen/);
  assert.doesNotMatch(md, /## Notiz/);
});

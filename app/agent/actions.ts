// Aktions-Layer für die Needle-Steuerung.
// Definiert die App-Aktionen als Tool-Liste (für Needle) und führt die von
// Needle zurückgegebenen Tool-Calls gegen eine bereitgestellte API aus.
// Bewusst unabhängig von React, damit es isoliert testbar bleibt.

export type Kind = "Aufgabe" | "Termin" | "Notiz" | "Idee";
export type View = "cards" | "list";
export type FilterValue = "Alle" | Kind;

// Handler, die die App bereitstellt. Matching-Funktionen geben zurück, wie
// viele Einträge betroffen waren, damit wir Feedback geben können.
export type ActionApi = {
  setView: (view: View) => void;
  setFilter: (filter: FilterValue) => void;
  setQuery: (query: string) => void;
  addEntry: (text: string) => void;
  deleteMatching: (match: string) => number;
  setKindMatching: (match: string, kind: Kind) => number;
  exportJson: () => void;
};

export type ToolCall = { name: string; arguments: Record<string, unknown> };
export type ExecResult = { ok: boolean; message: string };

const KINDS: Kind[] = ["Aufgabe", "Termin", "Notiz", "Idee"];

// Tool-Definitionen im OpenAI-Function-Format. Needle akzeptiert dieses Format
// und liefert `[{"name": ..., "arguments": {...}}]` zurück.
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "switch_view",
      description: "Wechselt die Anzeige der Inbox zwischen Kartenansicht und Listenansicht.",
      parameters: {
        type: "object",
        properties: { view: { type: "string", enum: ["cards", "list"], description: "Zielansicht" } },
        required: ["view"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "filter_kind",
      description: "Filtert die Inbox nach einer Kategorie oder zeigt alle Einträge.",
      parameters: {
        type: "object",
        properties: { kind: { type: "string", enum: ["Alle", ...KINDS], description: "Kategorie zum Filtern" } },
        required: ["kind"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Durchsucht die Inbox nach einem Suchbegriff.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Suchbegriff" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_search",
      description: "Leert die Suche und zeigt wieder alle Einträge.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "add_note",
      description: "Legt einen neuen Eintrag mit dem angegebenen Text in der Inbox ab.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Inhalt des neuen Eintrags" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_note",
      description: "Löscht Einträge, deren Text den angegebenen Text enthält.",
      parameters: {
        type: "object",
        properties: { match: { type: "string", description: "Textausschnitt der zu löschenden Einträge" } },
        required: ["match"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_kind",
      description: "Setzt die Kategorie von Einträgen, deren Text den angegebenen Text enthält.",
      parameters: {
        type: "object",
        properties: {
          match: { type: "string", description: "Textausschnitt der betroffenen Einträge" },
          kind: { type: "string", enum: KINDS, description: "Neue Kategorie" },
        },
        required: ["match", "kind"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "export_data",
      description: "Exportiert alle Einträge als JSON-Datei.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
] as const;

export const TOOLS_JSON = JSON.stringify(TOOLS);

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}
// Fuzzy-Auflösung: das 26M-Modell liefert Enum-Werte oft nicht exakt
// ("Liste" statt "list", "list view" …). Deshalb auf Schlüsselwörter matchen.
function resolveView(value: unknown): View {
  const v = asString(value).toLowerCase();
  if (/karte|kachel|card|grid/.test(v)) return "cards";
  if (/list|liste|zeile|row/.test(v)) return "list";
  return "cards";
}
function resolveKind(value: unknown): Kind | null {
  const v = asString(value).toLowerCase();
  if ((KINDS as string[]).includes(asString(value))) return asString(value) as Kind;
  if (/aufgabe|task|todo|to-?do|erledig/.test(v)) return "Aufgabe";
  if (/termin|appointment|kalender|meeting|date/.test(v)) return "Termin";
  if (/idee|idea|einfall/.test(v)) return "Idee";
  if (/notiz|note|memo/.test(v)) return "Notiz";
  return null;
}
function resolveFilter(value: unknown): FilterValue {
  const v = asString(value).toLowerCase();
  if (!v || /alle|all|alles|everything/.test(v)) return "Alle";
  return resolveKind(value) ?? "Alle";
}

// Normalisiert die (evtl. unterschiedliche) Needle-Ausgabe in ToolCall[].
export function parseToolCalls(raw: string): ToolCall[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : [data];
  const calls: ToolCall[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    // OpenAI-Form {function:{name,arguments}} oder flach {name,arguments}.
    const fn = (obj.function as Record<string, unknown> | undefined) ?? obj;
    const name = asString(fn.name);
    if (!name) continue;
    let args = fn.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    calls.push({ name, arguments: (args as Record<string, unknown>) ?? {} });
  }
  return calls;
}

// Führt genau einen Tool-Call gegen die API aus und liefert eine Meldung.
export function executeToolCall(call: ToolCall, api: ActionApi): ExecResult {
  const { name, arguments: args } = call;
  switch (name) {
    case "switch_view": {
      const view = resolveView(args.view);
      api.setView(view);
      return { ok: true, message: view === "list" ? "Listenansicht" : "Kartenansicht" };
    }
    case "filter_kind": {
      const filter = resolveFilter(args.kind);
      api.setFilter(filter);
      return { ok: true, message: `Filter: ${filter}` };
    }
    case "search": {
      const query = asString(args.query);
      api.setQuery(query);
      return { ok: true, message: `Suche nach „${query}“` };
    }
    case "clear_search": {
      api.setQuery("");
      return { ok: true, message: "Suche zurückgesetzt" };
    }
    case "add_note": {
      const text = asString(args.text).trim();
      if (!text) return { ok: false, message: "Kein Text für den neuen Eintrag" };
      api.addEntry(text);
      return { ok: true, message: "Eintrag angelegt" };
    }
    case "delete_note": {
      const match = asString(args.match).trim();
      if (!match) return { ok: false, message: "Kein Suchtext zum Löschen" };
      const count = api.deleteMatching(match);
      return count > 0
        ? { ok: true, message: `${count} Eintrag/Einträge gelöscht` }
        : { ok: false, message: `Nichts gefunden für „${match}“` };
    }
    case "set_kind": {
      const match = asString(args.match).trim();
      const kind = resolveKind(args.kind);
      if (!match || !kind) return { ok: false, message: "Ungültige Angaben für Kategorie" };
      const count = api.setKindMatching(match, kind);
      return count > 0
        ? { ok: true, message: `${count} Eintrag/Einträge → ${kind}` }
        : { ok: false, message: `Nichts gefunden für „${match}“` };
    }
    case "export_data": {
      api.exportJson();
      return { ok: true, message: "Export gestartet" };
    }
    default:
      return { ok: false, message: `Unbekannte Aktion: ${name}` };
  }
}

// Parst die Needle-Ausgabe und führt alle Tool-Calls aus.
export function runToolCalls(raw: string, api: ActionApi): ExecResult {
  const calls = parseToolCalls(raw);
  if (calls.length === 0) return { ok: false, message: "Kein passender Befehl erkannt" };
  const results = calls.map((call) => executeToolCall(call, api));
  const ok = results.every((r) => r.ok);
  return { ok, message: results.map((r) => r.message).join(" · ") };
}

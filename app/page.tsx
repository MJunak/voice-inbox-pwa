"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { TOOLS_JSON, tryFastPath, executeToolCall, parseToolCalls, parseModelInfo, describeToolCall, type ActionApi, type ToolCall } from "./agent/actions";
import { resolveEngine, preloadEngine } from "./agent/engine";

type ModelState = "idle" | "loading" | "ready" | "error";

type Kind = "Aufgabe" | "Termin" | "Notiz" | "Idee";
type Entry = { id: string; kind: Kind; text: string; created: string; updatedAt: string; deletedAt?: string };
type SyncConfig = { url: string; token: string };
type View = "cards" | "list";
type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type Recognition = { lang: string; continuous: boolean; interimResults: boolean; onresult: ((event: { results: ArrayLike<SpeechResult> }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void };
type RecognitionConstructor = new () => Recognition;

const KINDS: Kind[] = ["Aufgabe", "Termin", "Notiz", "Idee"];
const colors: Record<Kind, string> = { Aufgabe: "blue", Termin: "orange", Notiz: "violet", Idee: "green" };
type SpeechLang = "de-DE" | "es-ES" | "en-US";
const SPEECH_LANGS: Array<{ value: SpeechLang; label: string }> = [
  { value: "de-DE", label: "DE" },
  { value: "es-ES", label: "ES" },
  { value: "en-US", label: "EN" },
];
function classify(text: string): Kind {
  const value = text.toLowerCase();
  if (/morgen|uhr|termin|treffen|montag|dienstag|mittwoch|donnerstag|freitag|cita|reunión|reunion|mañana|lunes|martes|miércoles|miercoles|jueves|viernes/.test(value)) return "Termin";
  if (/muss|erledigen|machen|aufgabe|todo|erinner|tengo que|tarea|pagar/.test(value)) return "Aufgabe";
  if (/idee|vielleicht|könnte|vorschlag|idea|quizás|quizas|podría|podria/.test(value)) return "Idee";
  return "Notiz";
}
function readStoredEntries(): Entry[] {
  try {
    const stored = localStorage.getItem("voice-inbox-entries");
    if (!stored) return [];
    const parsed = JSON.parse(stored) as Array<Entry & { title?: string; detail?: string }>;
    const migratedAt = new Date().toISOString();
    return parsed.map(({ id, kind, text, title, detail, created, updatedAt, deletedAt }) => ({ id, kind, text: text ?? [title, detail && !detail.startsWith("Automatisch lokal erkannt") ? detail : ""].filter(Boolean).join("\n"), created, updatedAt: updatedAt ?? migratedAt, deletedAt }));
  } catch { return []; }
}

function mergeEntries(local: Entry[], remote: Entry[]) {
  const merged = new Map<string, Entry>();
  [...local, ...remote].forEach((entry) => {
    const current = merged.get(entry.id);
    if (!current || entry.updatedAt > current.updatedAt) merged.set(entry.id, entry);
  });
  return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export default function Home() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [filter, setFilter] = useState<"Alle" | Kind>("Alle");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("cards");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [command, setCommand] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentStatus, setAgentStatus] = useState("");
  const [modelState, setModelState] = useState<ModelState>("idle");
  const [modelProgress, setModelProgress] = useState(0);
  const [cmdListening, setCmdListening] = useState(false);
  const cmdRecognitionRef = useRef<Recognition | null>(null);
  const [speechLang, setSpeechLang] = useState<SpeechLang>("de-DE");
  const speechLangRef = useRef<SpeechLang>("de-DE");
  const [debug, setDebug] = useState<{ query: string; raw: string; message: string; ms: number; path: string; confidence?: number; reasoning?: string } | null>(null);
  const [pending, setPending] = useState<{ calls: ToolCall[]; confidence?: number } | null>(null);
  const [syncConfig, setSyncConfig] = useState<SyncConfig>({ url: "", token: "" });
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncState, setSyncState] = useState<"local" | "syncing" | "synced" | "error">("local");
  const recognitionRef = useRef<Recognition | null>(null);
  const draftRef = useRef("");
  const wantsToListenRef = useRef(false);
  const sessionStartRef = useRef("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const entriesRef = useRef<Entry[]>([]);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      const storedLang = localStorage.getItem("voice-inbox-lang") as SpeechLang | null;
      if (storedLang && SPEECH_LANGS.some((l) => l.value === storedLang)) { setSpeechLang(storedLang); speechLangRef.current = storedLang; }
      try { setSyncConfig(JSON.parse(localStorage.getItem("voice-inbox-sync") ?? '{"url":"","token":""}')); } catch { /* lokale Fehlkonfiguration ignorieren */ }
      setEntries(readStoredEntries()); setLoaded(true);
    }, 0);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
    return () => { window.clearTimeout(loadTimer); wantsToListenRef.current = false; recognitionRef.current?.stop(); cmdRecognitionRef.current?.stop(); };
  }, []);
  useEffect(() => { entriesRef.current = entries; if (loaded) localStorage.setItem("voice-inbox-entries", JSON.stringify(entries)); }, [entries, loaded]);

  // Needle-2-Modell im Hintergrund vorladen (einmalig, ~14 MB) und die Tools
  // gleich binden, damit der erste Befehl sofort inferieren kann. Bei
  // Testeinspeisung (Mock-Engine) ist es No-op.
  useEffect(() => {
    let cancelled = false;
    const start = () => {
      setModelState("loading");
      preloadEngine(TOOLS_JSON, (loadedBytes, total) => { if (!cancelled) setModelProgress(total ? loadedBytes / total : 0); })
        .then(() => { if (!cancelled) setModelState("ready"); })
        .catch(() => { if (!cancelled) setModelState("error"); });
    };
    const idle = window.setTimeout(start, 800);
    return () => { cancelled = true; window.clearTimeout(idle); };
  }, []);

  const activeEntries = useMemo(() => entries.filter((entry) => !entry.deletedAt), [entries]);
  const visible = useMemo(() => activeEntries.filter((entry) => (filter === "Alle" || entry.kind === filter) && entry.text.toLowerCase().includes(query.toLowerCase())), [activeEntries, filter, query]);

  async function synchronize(config = syncConfig) {
    if (!config.url || !config.token) { setSyncOpen(true); return; }
    setSyncState("syncing");
    try {
      const endpoint = `${config.url.replace(/\/$/, "")}/v1/entries`;
      const headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
      const response = await fetch(endpoint, { headers });
      if (!response.ok) throw new Error("Abruf fehlgeschlagen");
      const remote = await response.json() as { entries: Entry[] };
      const merged = mergeEntries(entriesRef.current, remote.entries ?? []);
      const saved = await fetch(endpoint, { method: "PUT", headers, body: JSON.stringify({ entries: merged }) });
      if (!saved.ok) throw new Error("Speichern fehlgeschlagen");
      setEntries(merged); setSyncState("synced"); flash("Mit VPS synchronisiert");
    } catch { setSyncState("error"); flash("VPS-Synchronisierung fehlgeschlagen"); }
  }

  function saveSyncConfig() {
    const config = { ...syncConfig, url: syncConfig.url.trim().replace(/\/$/, "") };
    setSyncConfig(config); localStorage.setItem("voice-inbox-sync", JSON.stringify(config));
    setSyncOpen(false); void synchronize(config);
  }

  function beginRecognition(RecognitionApi: RecognitionConstructor, baseText: string) {
    const recognition = new RecognitionApi();
    recognition.lang = speechLangRef.current; recognition.continuous = true; recognition.interimResults = true;
    sessionStartRef.current = baseText.trimEnd();
    recognition.onresult = (event) => {
      let finalText = ""; let interimText = "";
      for (let index = 0; index < event.results.length; index += 1) {
        const transcript = event.results[index][0].transcript;
        if (event.results[index].isFinal) finalText += transcript; else interimText += transcript;
      }
      const nextDraft = `${sessionStartRef.current}${sessionStartRef.current ? " " : ""}${finalText}${interimText}`;
      draftRef.current = nextDraft; setDraft(nextDraft);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      if (wantsToListenRef.current) window.setTimeout(() => beginRecognition(RecognitionApi, draftRef.current), 120);
      else setListening(false);
    };
    recognitionRef.current = recognition; recognition.start(); setListening(true);
  }

  function toggleListening() {
    if (wantsToListenRef.current) { wantsToListenRef.current = false; recognitionRef.current?.stop(); return; }
    const speechWindow = window as typeof window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
    const RecognitionApi = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!RecognitionApi) { alert("Spracherkennung wird in diesem Browser nicht unterstützt. Nutze Chrome oder Edge."); return; }
    wantsToListenRef.current = true; beginRecognition(RecognitionApi, draft);
  }
  function addEntry() {
    const text = draft.trim(); if (!text) return;
    wantsToListenRef.current = false; recognitionRef.current?.stop();
    // Eingabe nach dem Ablegen leeren, damit sofort ein neuer Eintrag begonnen werden kann.
    setEntries((current) => [{ id: crypto.randomUUID(), kind: classify(text), text, created: "Gerade eben", updatedAt: new Date().toISOString() }, ...current]);
    draftRef.current = ""; setDraft("");
  }
  function deleteEntry(id: string) {
    const stamp = new Date().toISOString();
    setEntries((current) => current.map((item) => item.id === id ? { ...item, deletedAt: stamp, updatedAt: stamp } : item));
  }
  // Tag manuell umschalten: zyklisch durch die Kinds.
  function cycleKind(id: string) {
    setEntries((current) => current.map((item) => item.id === id ? { ...item, kind: KINDS[(KINDS.indexOf(item.kind) + 1) % KINDS.length], updatedAt: new Date().toISOString() } : item));
  }
  async function copyEntry(entry: Entry) {
    try {
      await navigator.clipboard.writeText(entry.text);
      setCopiedId(entry.id);
      window.setTimeout(() => setCopiedId((current) => (current === entry.id ? null : current)), 1400);
    } catch { flash("Kopieren nicht möglich"); }
  }
  function flash(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? "" : current)), 2500);
  }
  function exportJson() {
    const blob = new Blob([JSON.stringify(activeEntries, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "voice-inbox-export.json"; link.click();
    URL.revokeObjectURL(url);
    flash(`${activeEntries.length} Einträge exportiert`);
  }
  function importJson(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as Entry[];
        if (!Array.isArray(parsed)) throw new Error("kein Array");
        const importedAt = new Date().toISOString();
        const cleaned = parsed
          .filter((item) => item && typeof item.text === "string")
          .map((item) => ({ id: item.id ?? crypto.randomUUID(), kind: KINDS.includes(item.kind) ? item.kind : classify(item.text), text: item.text, created: item.created ?? "Importiert", updatedAt: item.updatedAt ?? importedAt }));
        setEntries(cleaned);
        flash(`${cleaned.length} Einträge importiert`);
      } catch { flash("Import fehlgeschlagen: ungültige JSON-Datei"); }
    };
    reader.readAsText(file);
  }

  // ActionApi für die Needle-Steuerung. Matching-Operationen zählen betroffene
  // Einträge über entriesRef (aktueller State) und liefern die Anzahl zurück.
  const actionApi: ActionApi = {
    setView,
    setFilter,
    setQuery,
    addEntry: (text) => setEntries((current) => [{ id: crypto.randomUUID(), kind: classify(text), text, created: "Gerade eben", updatedAt: new Date().toISOString() }, ...current]),
    deleteMatching: (match) => {
      const needle = match.toLowerCase();
      const count = entriesRef.current.filter((entry) => !entry.deletedAt && entry.text.toLowerCase().includes(needle)).length;
      if (count) { const stamp = new Date().toISOString(); setEntries((current) => current.map((entry) => !entry.deletedAt && entry.text.toLowerCase().includes(needle) ? { ...entry, deletedAt: stamp, updatedAt: stamp } : entry)); }
      return count;
    },
    deleteLatest: (kind) => {
      // Neuester Eintrag steht vorn (wird beim Anlegen vorangestellt).
      const target = (kind && entriesRef.current.find((entry) => !entry.deletedAt && entry.kind === kind)) ?? entriesRef.current.find((entry) => !entry.deletedAt);
      if (!target) return null;
      const stamp = new Date().toISOString(); setEntries((current) => current.map((entry) => entry.id === target.id ? { ...entry, deletedAt: stamp, updatedAt: stamp } : entry));
      return { text: target.text, kind: target.kind };
    },
    setKindMatching: (match, kind) => {
      const needle = match.toLowerCase();
      const count = entriesRef.current.filter((entry) => !entry.deletedAt && entry.text.toLowerCase().includes(needle)).length;
      if (count) setEntries((current) => current.map((entry) => (!entry.deletedAt && entry.text.toLowerCase().includes(needle) ? { ...entry, kind, updatedAt: new Date().toISOString() } : entry)));
      return count;
    },
    exportJson,
  };

  // Sprach-Eingabe für die Command-Bar: one-shot-Erkennung (de-DE), Interim-
  // Text landet live im Eingabefeld, das finale Ergebnis wird direkt ausgeführt.
  function toggleCommandListening() {
    if (cmdRecognitionRef.current) { cmdRecognitionRef.current.stop(); return; }
    const speechWindow = window as typeof window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
    const RecognitionApi = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!RecognitionApi) { flash("Spracherkennung wird in diesem Browser nicht unterstützt. Nutze Chrome oder Edge."); return; }
    const recognition = new RecognitionApi();
    recognition.lang = speechLangRef.current; recognition.continuous = false; recognition.interimResults = true;
    recognition.onresult = (event) => {
      let finalText = ""; let interimText = "";
      for (let index = 0; index < event.results.length; index += 1) {
        const transcript = event.results[index][0].transcript;
        if (event.results[index].isFinal) finalText += transcript; else interimText += transcript;
      }
      setCommand(finalText || interimText);
      if (finalText.trim()) { recognition.stop(); runCommand(finalText.trim()); }
    };
    recognition.onend = () => { cmdRecognitionRef.current = null; setCmdListening(false); };
    cmdRecognitionRef.current = recognition; recognition.start(); setCmdListening(true);
  }

  async function runCommand(textOverride?: string) {
    const text = (textOverride ?? command).trim();
    if (!text || agentBusy) return;

    // Fast-Path: eindeutige Befehle sofort ausführen, ohne Modell (0 ms).
    const fastCalls = tryFastPath(text);
    if (fastCalls) {
      const results = fastCalls.map((call) => executeToolCall(call, actionApi));
      const message = results.map((r) => r.message).join(" · ");
      setDebug({ query: text, raw: JSON.stringify(fastCalls), message, ms: 0, path: "Fast-Path (Regex, ohne Modell)" });
      flash(message);
      if (results.every((r) => r.ok)) setCommand("");
      return;
    }

    setAgentBusy(true);
    setAgentStatus(modelState === "ready" ? "Denke nach …" : "Modell wird geladen …");
    setDebug({ query: text, raw: "", message: "", ms: 0, path: "Needle 2 (WASM)" });
    const start = performance.now();
    try {
      const engine = resolveEngine((loadedBytes, total) => setModelProgress(total ? loadedBytes / total : 0));
      const raw = await engine.run(text, TOOLS_JSON);
      const calls = parseToolCalls(raw);
      const info = parseModelInfo(raw);
      if (calls.length === 0) {
        setDebug((d) => d && { ...d, raw, message: "Kein passender Befehl erkannt", ms: performance.now() - start, ...info });
        flash("Kein passender Befehl erkannt");
      } else {
        // Nicht sofort ausführen: Vorschau anzeigen, Nutzer bestätigt.
        setPending({ calls, confidence: info.confidence });
        setDebug((d) => d && { ...d, raw, message: "wartet auf Bestätigung …", ms: performance.now() - start, ...info });
      }
    } catch (error) {
      const message = `Fehler: ${(error as Error).message}`;
      setDebug((d) => d && { ...d, message, ms: performance.now() - start });
      flash(message);
    } finally {
      setAgentBusy(false); setAgentStatus("");
    }
  }

  function confirmPending() {
    if (!pending) return;
    const results = pending.calls.map((call) => executeToolCall(call, actionApi));
    const message = results.map((r) => r.message).join(" · ");
    setDebug((d) => d && { ...d, message });
    flash(message);
    if (results.every((r) => r.ok)) setCommand("");
    setPending(null);
  }
  function discardPending() {
    setPending(null);
    setDebug((d) => d && { ...d, message: "verworfen" });
    flash("Aktion verworfen");
  }

  const modelLabel =
    modelState === "ready" ? "Needle bereit"
    : modelState === "loading" ? `Needle lädt … ${Math.round(modelProgress * 100)}%`
    : modelState === "error" ? "Needle nicht geladen"
    : "Needle";

  function changeSpeechLang(lang: SpeechLang) {
    setSpeechLang(lang); speechLangRef.current = lang;
    localStorage.setItem("voice-inbox-lang", lang);
    // laufende Aufnahmen mit alter Sprache beenden
    wantsToListenRef.current = false; recognitionRef.current?.stop(); cmdRecognitionRef.current?.stop();
  }

  return <main>
    <header className="topbar"><a className="brand" href="./"><span className="logo">V</span><span>Voice Inbox</span></a><div className="topbarRight"><button className={`syncButton ${syncState}`} onClick={() => syncConfig.url ? void synchronize() : setSyncOpen(true)}><span />{syncState === "syncing" ? "Sync …" : syncState === "synced" ? "VPS aktuell" : syncState === "error" ? "Sync-Fehler" : syncConfig.url ? "VPS Sync" : "Sync einrichten"}</button><select className="langSelect" value={speechLang} onChange={(event) => changeSpeechLang(event.target.value as SpeechLang)} aria-label="Sprache der Spracherkennung" title="Sprache der Spracherkennung">{SPEECH_LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</select><a className="inboxLink" href="#inbox">Inbox <b>{activeEntries.length}</b></a></div></header>
    <section className="hero">
      <div className={`composer ${listening ? "isListening" : ""}`}>
        <div className="composerHead"><div><strong>Neuer Eintrag</strong><span>{listening ? "Aufnahme läuft – sprich einfach weiter" : "Aufnehmen oder direkt losschreiben"}</span></div><button className="mic" onClick={toggleListening} aria-label={listening ? "Aufnahme stoppen" : "Aufnahme starten"} title={`Spracherkennung: ${speechLang} – umschaltbar oben rechts`}><span>{listening ? "■" : "●"}</span>{listening ? "Stoppen" : "Aufnehmen"}<em>{SPEECH_LANGS.find((l) => l.value === speechLang)?.label}</em></button></div>
        <textarea value={draft} onChange={(event) => { draftRef.current = event.target.value; setDraft(event.target.value); }} placeholder="Hier entsteht dein Text …" aria-label="Text für einen neuen Inbox-Eintrag" />
        <div className="composerBottom"><span>{draft.length ? `${draft.length} Zeichen` : "Text ist jederzeit bearbeitbar."}</span><button onClick={addEntry} disabled={!draft.trim()}>In Inbox ablegen <span>→</span></button></div>
      </div>
    </section>
    <section className="inbox" id="inbox">
      <div className="sectionHead"><div><h2>Inbox</h2><p>{activeEntries.length} Einträge gespeichert.</p></div><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="⌕  Durchsuchen …" aria-label="Inbox durchsuchen" /></div>
      <form className="commandBar" onSubmit={(event) => { event.preventDefault(); runCommand(); }}>
        <span className="cmdIcon" aria-hidden="true">⌘</span>
        <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={cmdListening ? "Sprich deinen Befehl …" : "Befehl … z. B. „zeig mir die Liste“ oder „lösche den Zahnarzt-Termin“"} aria-label="Befehl an die App (Needle)" />
        <button type="button" className={`cmdMic ${cmdListening ? "on" : ""}`} onClick={toggleCommandListening} aria-label={cmdListening ? "Aufnahme stoppen" : "Befehl einsprechen"} title={cmdListening ? "Aufnahme stoppen" : "Befehl einsprechen"}>{cmdListening ? "■" : "●"}</button>
        <span className={`cmdModel ${modelState}`} title="Lokales Needle-Modell (WASM, im Browser)" role="status">{agentBusy && agentStatus ? agentStatus : modelLabel}</span>
        <button type="submit" disabled={agentBusy || !command.trim()}>{agentBusy ? <span className="spinner" aria-label="arbeitet" /> : "Ausführen"}</button>
      </form>
      {pending && <div className="preview" role="dialog" aria-label="Vorschau der Aktion">
        <div className="previewHead">
          <strong>Needle möchte:</strong>
          {typeof pending.confidence === "number" && <span className={`previewConf ${pending.confidence < 0.3 ? "low" : ""}`}>{(pending.confidence * 100).toFixed(0)} % sicher</span>}
        </div>
        <ul>{pending.calls.map((call, index) => <li key={index}>{describeToolCall(call)}</li>)}</ul>
        <div className="previewActions">
          <button className="confirm" onClick={confirmPending}>Bestätigen</button>
          <button className="discard" onClick={discardPending}>Verwerfen</button>
        </div>
      </div>}
      <details className="debugPanel">
        <summary>Debug: Inferenz</summary>
        {debug ? <dl>
          <dt>Befehl</dt><dd>{debug.query}</dd>
          <dt>Pfad</dt><dd>{debug.path}</dd>
          <dt>Roh-Ausgabe</dt><dd><code className={agentBusy ? "streaming" : ""}>{debug.raw || (agentBusy ? "…" : "—")}</code></dd>
          {debug.reasoning && <><dt>Reasoning</dt><dd>{debug.reasoning}</dd></>}
          {typeof debug.confidence === "number" && <><dt>Confidence</dt><dd>{(debug.confidence * 100).toFixed(1)} %</dd></>}
          <dt>Ergebnis</dt><dd>{debug.message || (agentBusy ? "läuft …" : "—")}</dd>
          <dt>Dauer</dt><dd>{debug.ms < 1 ? "sofort" : `${(debug.ms / 1000).toFixed(1)} s`}</dd>
        </dl> : <p className="debugEmpty">Noch kein Befehl ausgeführt. Hier erscheinen Roh-Ausgabe, Reasoning und Confidence des Modells.</p>}
      </details>
      <div className="toolbar">
        <div className="filters">{(["Alle", "Aufgabe", "Termin", "Notiz", "Idee"] as const).map((item) => <button className={filter === item ? "active" : ""} onClick={() => setFilter(item)} key={item}>{item}{item === "Alle" && <span>{activeEntries.length}</span>}</button>)}</div>
        <div className="viewToggle" role="group" aria-label="Ansicht umschalten">
          <button className={view === "cards" ? "active" : ""} onClick={() => setView("cards")} aria-pressed={view === "cards"} aria-label="Kartenansicht">▦ Karten</button>
          <button className={view === "list" ? "active" : ""} onClick={() => setView("list")} aria-pressed={view === "list"} aria-label="Listenansicht">☰ Liste</button>
        </div>
      </div>
      {view === "cards"
        ? <div className="grid">{visible.map((entry) => <article key={entry.id} className="card">
            <div className="cardTop">
              <button className={`tag ${colors[entry.kind]}`} onClick={() => cycleKind(entry.id)} title="Kategorie ändern" aria-label={`Kategorie ${entry.kind}, klicken zum Ändern`}>{entry.kind}</button>
              <div className="cardActions">
                <button className="ghost" onClick={() => copyEntry(entry)} aria-label="Kopieren">{copiedId === entry.id ? "✓" : "⧉"}</button>
                <button className="ghost" onClick={() => deleteEntry(entry.id)} aria-label="Löschen">×</button>
              </div>
            </div>
            <p className="entryText">{entry.text}</p>
            <footer><span>{entry.created}</span></footer>
          </article>)}{visible.length === 0 && <div className="empty">Noch keine Einträge.</div>}</div>
        : <div className="list">{visible.map((entry) => <div key={entry.id} className="row">
            <button className={`tag ${colors[entry.kind]}`} onClick={() => cycleKind(entry.id)} title="Kategorie ändern" aria-label={`Kategorie ${entry.kind}, klicken zum Ändern`}>{entry.kind}</button>
            <span className="rowText">{entry.text}</span>
            <span className="rowMeta">{entry.created}</span>
            <button className="ghost" onClick={() => copyEntry(entry)} aria-label="Kopieren">{copiedId === entry.id ? "✓" : "⧉"}</button>
            <button className="ghost" onClick={() => deleteEntry(entry.id)} aria-label="Löschen">×</button>
          </div>)}{visible.length === 0 && <div className="empty">Noch keine Einträge.</div>}</div>}
      <div className="dataBar">
        <button onClick={exportJson} disabled={activeEntries.length === 0}>Export als JSON</button>
        <button onClick={() => fileInputRef.current?.click()}>Import aus JSON</button>
        <input ref={fileInputRef} type="file" accept="application/json,.json" hidden aria-label="JSON-Datei importieren" onChange={(event) => { const file = event.target.files?.[0]; if (file) importJson(file); event.target.value = ""; }} />
        {notice && <span className="notice" role="status">{notice}</span>}
      </div>
    </section>
    {syncOpen && <div className="modalBackdrop" onClick={() => setSyncOpen(false)}><form className="syncModal" autoComplete="on" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); saveSyncConfig(); }}><button type="button" className="modalClose" onClick={() => setSyncOpen(false)} aria-label="Schließen">×</button><span className="tag green">Eigener Server</span><h2>VPS-Synchronisierung</h2><p>URL und Token werden nur lokal in diesem Browser gespeichert. Die Einträge gehen ausschließlich an deinen VPS.</p><label htmlFor="sync-server">API-Adresse<input id="sync-server" name="username" type="text" inputMode="url" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="https://strato-vpc.…ts.net:8443" value={syncConfig.url} onChange={(event) => setSyncConfig({ ...syncConfig, url: event.target.value })}/></label><label htmlFor="sync-token">Zugangs-Token<input id="sync-token" name="password" type="password" autoComplete="current-password" placeholder="Token vom VPS" value={syncConfig.token} onChange={(event) => setSyncConfig({ ...syncConfig, token: event.target.value })}/></label><button type="submit" className="saveSync">Speichern & synchronisieren</button></form></div>}
  </main>;
}

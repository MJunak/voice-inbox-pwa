"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { TOOLS_JSON, runToolCalls, type ActionApi } from "./agent/actions";
import { resolveEngine, preloadEngine } from "./agent/engine";

type ModelState = "idle" | "loading" | "ready" | "error";

type Kind = "Aufgabe" | "Termin" | "Notiz" | "Idee";
type Entry = { id: string; kind: Kind; text: string; created: string };
type View = "cards" | "list";
type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type Recognition = { lang: string; continuous: boolean; interimResults: boolean; onresult: ((event: { results: ArrayLike<SpeechResult> }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void };
type RecognitionConstructor = new () => Recognition;

const KINDS: Kind[] = ["Aufgabe", "Termin", "Notiz", "Idee"];
const colors: Record<Kind, string> = { Aufgabe: "blue", Termin: "orange", Notiz: "violet", Idee: "green" };
function classify(text: string): Kind {
  const value = text.toLowerCase();
  if (/morgen|uhr|termin|treffen|montag|dienstag|mittwoch|donnerstag|freitag/.test(value)) return "Termin";
  if (/muss|erledigen|machen|aufgabe|todo|erinner/.test(value)) return "Aufgabe";
  if (/idee|vielleicht|könnte|vorschlag/.test(value)) return "Idee";
  return "Notiz";
}
function readStoredEntries(): Entry[] {
  try {
    const stored = localStorage.getItem("voice-inbox-entries");
    if (!stored) return [];
    const parsed = JSON.parse(stored) as Array<Entry & { title?: string; detail?: string }>;
    return parsed.map(({ id, kind, text, title, detail, created }) => ({ id, kind, text: text ?? [title, detail && !detail.startsWith("Automatisch lokal erkannt") ? detail : ""].filter(Boolean).join("\n"), created }));
  } catch { return []; }
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
  const recognitionRef = useRef<Recognition | null>(null);
  const draftRef = useRef("");
  const wantsToListenRef = useRef(false);
  const sessionStartRef = useRef("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const entriesRef = useRef<Entry[]>([]);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => { setEntries(readStoredEntries()); setLoaded(true); }, 0);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
    return () => { window.clearTimeout(loadTimer); wantsToListenRef.current = false; recognitionRef.current?.stop(); };
  }, []);
  useEffect(() => { entriesRef.current = entries; if (loaded) localStorage.setItem("voice-inbox-entries", JSON.stringify(entries)); }, [entries, loaded]);

  // Needle-Modell im Hintergrund vorladen (einmalig, ~22 MB), damit der erste
  // Befehl nicht auf den Download warten muss. Bei Testeinspeisung ist es No-op.
  useEffect(() => {
    let cancelled = false;
    const start = () => {
      setModelState("loading");
      preloadEngine((loadedBytes, total) => { if (!cancelled) setModelProgress(total ? loadedBytes / total : 0); })
        .then(() => { if (!cancelled) setModelState("ready"); })
        .catch(() => { if (!cancelled) setModelState("error"); });
    };
    const idle = window.setTimeout(start, 800);
    return () => { cancelled = true; window.clearTimeout(idle); };
  }, []);

  const visible = useMemo(() => entries.filter((entry) => (filter === "Alle" || entry.kind === filter) && entry.text.toLowerCase().includes(query.toLowerCase())), [entries, filter, query]);

  function beginRecognition(RecognitionApi: RecognitionConstructor, baseText: string) {
    const recognition = new RecognitionApi();
    recognition.lang = "de-DE"; recognition.continuous = true; recognition.interimResults = true;
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
    setEntries((current) => [{ id: crypto.randomUUID(), kind: classify(text), text, created: "Gerade eben" }, ...current]);
    draftRef.current = ""; setDraft("");
  }
  function deleteEntry(id: string) {
    setEntries((current) => current.filter((item) => item.id !== id));
  }
  // Tag manuell umschalten: zyklisch durch die Kinds.
  function cycleKind(id: string) {
    setEntries((current) => current.map((item) => item.id === id ? { ...item, kind: KINDS[(KINDS.indexOf(item.kind) + 1) % KINDS.length] } : item));
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
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "voice-inbox-export.json"; link.click();
    URL.revokeObjectURL(url);
    flash(`${entries.length} Einträge exportiert`);
  }
  function importJson(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as Entry[];
        if (!Array.isArray(parsed)) throw new Error("kein Array");
        const cleaned = parsed
          .filter((item) => item && typeof item.text === "string")
          .map((item) => ({ id: item.id ?? crypto.randomUUID(), kind: KINDS.includes(item.kind) ? item.kind : classify(item.text), text: item.text, created: item.created ?? "Importiert" }));
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
    addEntry: (text) => setEntries((current) => [{ id: crypto.randomUUID(), kind: classify(text), text, created: "Gerade eben" }, ...current]),
    deleteMatching: (match) => {
      const needle = match.toLowerCase();
      const count = entriesRef.current.filter((entry) => entry.text.toLowerCase().includes(needle)).length;
      if (count) setEntries((current) => current.filter((entry) => !entry.text.toLowerCase().includes(needle)));
      return count;
    },
    setKindMatching: (match, kind) => {
      const needle = match.toLowerCase();
      const count = entriesRef.current.filter((entry) => entry.text.toLowerCase().includes(needle)).length;
      if (count) setEntries((current) => current.map((entry) => (entry.text.toLowerCase().includes(needle) ? { ...entry, kind } : entry)));
      return count;
    },
    exportJson,
  };

  async function runCommand() {
    const text = command.trim();
    if (!text || agentBusy) return;
    setAgentBusy(true);
    setAgentStatus(modelState === "ready" ? "Denke nach …" : "Modell wird geladen …");
    try {
      const engine = resolveEngine((loadedBytes, total) => setModelProgress(total ? loadedBytes / total : 0));
      const raw = await engine.run(text, TOOLS_JSON);
      const result = runToolCalls(raw, actionApi);
      flash(result.message);
      if (result.ok) setCommand("");
    } catch (error) {
      flash(`Fehler: ${(error as Error).message}`);
    } finally {
      setAgentBusy(false); setAgentStatus("");
    }
  }

  const modelLabel =
    modelState === "ready" ? "Needle bereit"
    : modelState === "loading" ? `Needle lädt … ${Math.round(modelProgress * 100)}%`
    : modelState === "error" ? "Needle nicht geladen"
    : "Needle";

  return <main>
    <header className="topbar"><a className="brand" href="./"><span className="logo">V</span><span>Voice Inbox</span></a><a className="inboxLink" href="#inbox">Inbox <b>{entries.length}</b></a></header>
    <section className="hero">
      <div className={`composer ${listening ? "isListening" : ""}`}>
        <div className="composerHead"><div><strong>Neuer Eintrag</strong><span>{listening ? "Aufnahme läuft – sprich einfach weiter" : "Aufnehmen oder direkt losschreiben"}</span></div><button className="mic" onClick={toggleListening} aria-label={listening ? "Aufnahme stoppen" : "Aufnahme starten"}><span>{listening ? "■" : "●"}</span>{listening ? "Stoppen" : "Aufnehmen"}</button></div>
        <textarea value={draft} onChange={(event) => { draftRef.current = event.target.value; setDraft(event.target.value); }} placeholder="Hier entsteht dein Text …" aria-label="Text für einen neuen Inbox-Eintrag" />
        <div className="composerBottom"><span>{draft.length ? `${draft.length} Zeichen` : "Text ist jederzeit bearbeitbar."}</span><button onClick={addEntry} disabled={!draft.trim()}>In Inbox ablegen <span>→</span></button></div>
      </div>
    </section>
    <section className="inbox" id="inbox">
      <div className="sectionHead"><div><h2>Inbox</h2><p>{entries.length} Einträge gespeichert.</p></div><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="⌕  Durchsuchen …" aria-label="Inbox durchsuchen" /></div>
      <form className="commandBar" onSubmit={(event) => { event.preventDefault(); runCommand(); }}>
        <span className="cmdIcon" aria-hidden="true">⌘</span>
        <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Befehl … z. B. „zeig mir die Liste“ oder „lösche den Zahnarzt-Termin“" aria-label="Befehl an die App (Needle)" />
        <span className={`cmdModel ${modelState}`} title="Lokales Needle-Modell (WASM, im Browser)" role="status">{agentBusy && agentStatus ? agentStatus : modelLabel}</span>
        <button type="submit" disabled={agentBusy || !command.trim()}>{agentBusy ? <span className="spinner" aria-label="arbeitet" /> : "Ausführen"}</button>
      </form>
      <div className="toolbar">
        <div className="filters">{(["Alle", "Aufgabe", "Termin", "Notiz", "Idee"] as const).map((item) => <button className={filter === item ? "active" : ""} onClick={() => setFilter(item)} key={item}>{item}{item === "Alle" && <span>{entries.length}</span>}</button>)}</div>
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
        <button onClick={exportJson} disabled={entries.length === 0}>Export als JSON</button>
        <button onClick={() => fileInputRef.current?.click()}>Import aus JSON</button>
        <input ref={fileInputRef} type="file" accept="application/json,.json" hidden aria-label="JSON-Datei importieren" onChange={(event) => { const file = event.target.files?.[0]; if (file) importJson(file); event.target.value = ""; }} />
        {notice && <span className="notice" role="status">{notice}</span>}
      </div>
    </section>
  </main>;
}

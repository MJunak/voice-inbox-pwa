"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { TOOLS_JSON, tryFastPath, executeToolCall, parseToolCalls, parseModelInfo, describeToolCall, type ActionApi, type ToolCall } from "./agent/actions";
import { resolveEngine, preloadEngine } from "./agent/engine";
import { KINDS, createEntry, dueState, dueToInput, formatCreated, formatDue, inputToDue, latestEntry, mergeEntries, normalizeEntries, parseDue, purgeTombstones, snoozeDue, sortForDisplay, toMarkdown, type Entry, type Kind } from "./inbox/model";

type ModelState = "idle" | "loading" | "ready" | "error";

type SyncConfig = { url: string; token: string };
type View = "cards" | "list";
type Status = "Offen" | "Erledigt" | "Gesamt";
type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type Recognition = { lang: string; continuous: boolean; interimResults: boolean; onresult: ((event: { results: ArrayLike<SpeechResult> }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void };
type RecognitionConstructor = new () => Recognition;

const colors: Record<Kind, string> = { Aufgabe: "blue", Termin: "orange", Notiz: "violet", Idee: "green" };
type SpeechLang = "de-DE" | "es-ES" | "en-US";
const SPEECH_LANGS: Array<{ value: SpeechLang; label: string }> = [
  { value: "de-DE", label: "DE" },
  { value: "es-ES", label: "ES" },
  { value: "en-US", label: "EN" },
];
const STORAGE_KEY = "voice-inbox-entries";

// Lädt den Bestand und migriert ältere Formate. Vor der ersten Migration eines
// v1-Bestands (ohne createdAt) bleibt eine Sicherungskopie liegen.
function readStoredEntries(): Entry[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    if (Array.isArray(parsed) && parsed.some((item) => item && typeof item === "object" && !("createdAt" in item)) && !localStorage.getItem(`${STORAGE_KEY}-v1-backup`)) {
      localStorage.setItem(`${STORAGE_KEY}-v1-backup`, stored);
    }
    return purgeTombstones(normalizeEntries(parsed));
  } catch { return []; }
}

// Kurzer Fingerabdruck des Bestands, um unnötige Auto-Syncs zu vermeiden.
function syncSignature(entries: Entry[]) {
  return entries.map((entry) => `${entry.id}@${entry.updatedAt}`).sort().join("|");
}

// Web Share Target (siehe manifest): geteilter Text/Link landet im Composer.
function readSharedText() {
  const params = new URLSearchParams(window.location.search);
  const shared = [params.get("title"), params.get("text"), params.get("url")].filter((part, index, all) => part && all.indexOf(part) === index).join("\n");
  if (params.has("title") || params.has("text") || params.has("url")) window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  return shared;
}

export default function Home() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [filter, setFilter] = useState<"Alle" | Kind>("Alle");
  const [status, setStatus] = useState<Status>("Offen");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [dueEditId, setDueEditId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
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
  const syncConfigRef = useRef<SyncConfig>({ url: "", token: "" });
  const syncingRef = useRef(false);
  const lastSyncedRef = useRef("");

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      const storedLang = localStorage.getItem("voice-inbox-lang") as SpeechLang | null;
      if (storedLang && SPEECH_LANGS.some((l) => l.value === storedLang)) { setSpeechLang(storedLang); speechLangRef.current = storedLang; }
      try { const config = JSON.parse(localStorage.getItem("voice-inbox-sync") ?? '{"url":"","token":""}') as SyncConfig; setSyncConfig(config); syncConfigRef.current = config; } catch { /* lokale Fehlkonfiguration ignorieren */ }
      const stored = readStoredEntries(); entriesRef.current = stored;
      setEntries(stored); setLoaded(true);
      const shared = readSharedText();
      if (shared) { draftRef.current = shared; setDraft(shared); }
      void synchronize(syncConfigRef.current, true);
    }, 0);
    const clock = window.setInterval(() => setNow(new Date()), 60_000);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
    return () => { window.clearTimeout(loadTimer); window.clearInterval(clock); wantsToListenRef.current = false; recognitionRef.current?.stop(); cmdRecognitionRef.current?.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { entriesRef.current = entries; if (loaded) localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); }, [entries, loaded]);

  // Auto-Sync: kurz nach jeder Änderung, beim Wiederverbinden und beim
  // Zurückkehren in die App. Ohne Konfiguration passiert nichts.
  useEffect(() => {
    if (!loaded || !syncConfig.url || !syncConfig.token || syncSignature(entries) === lastSyncedRef.current) return;
    const timer = window.setTimeout(() => void synchronize(syncConfigRef.current, true), 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, loaded, syncConfig]);
  useEffect(() => {
    const onWake = () => { if (document.visibilityState === "visible") void synchronize(syncConfigRef.current, true); };
    window.addEventListener("online", onWake); document.addEventListener("visibilitychange", onWake);
    return () => { window.removeEventListener("online", onWake); document.removeEventListener("visibilitychange", onWake); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!syncOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setSyncOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [syncOpen]);

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
  const doneCount = useMemo(() => activeEntries.filter((entry) => entry.done).length, [activeEntries]);
  const visible = useMemo(() => sortForDisplay(activeEntries.filter((entry) => (filter === "Alle" || entry.kind === filter) && (status === "Gesamt" || (status === "Erledigt") === !!entry.done) && entry.text.toLowerCase().includes(query.toLowerCase()))), [activeEntries, filter, status, query]);

  // Pull → Merge → Push. Änderungen, die während des Syncs entstehen, werden
  // in den aktuellen State gemerged statt überschrieben und lösen danach den
  // nächsten Auto-Sync aus.
  async function synchronize(config = syncConfigRef.current, silent = false) {
    if (!config.url || !config.token) { if (!silent) setSyncOpen(true); return; }
    if (syncingRef.current) return;
    if (silent && !navigator.onLine) { setSyncState("error"); return; }
    syncingRef.current = true; setSyncState("syncing");
    try {
      const endpoint = `${config.url.replace(/\/$/, "")}/v1/entries`;
      const headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
      const response = await fetch(endpoint, { headers });
      if (!response.ok) throw new Error(response.status === 401 ? "Token ungültig" : "Abruf fehlgeschlagen");
      const remote = normalizeEntries(await response.json());
      const merged = mergeEntries(entriesRef.current, remote);
      const saved = await fetch(endpoint, { method: "PUT", headers, body: JSON.stringify({ entries: merged }) });
      if (!saved.ok) throw new Error("Speichern fehlgeschlagen");
      const next = mergeEntries(entriesRef.current, merged);
      lastSyncedRef.current = syncSignature(merged);
      entriesRef.current = next; setEntries(next);
      setSyncState("synced"); if (!silent) flash("Mit VPS synchronisiert");
    } catch (error) {
      setSyncState("error"); if (!silent) flash(`VPS-Synchronisierung fehlgeschlagen${error instanceof Error && error.message !== "Failed to fetch" ? `: ${error.message}` : ""}`);
    } finally { syncingRef.current = false; }
  }

  function saveSyncConfig() {
    const config = { ...syncConfig, url: syncConfig.url.trim().replace(/\/$/, "") };
    setSyncConfig(config); syncConfigRef.current = config; localStorage.setItem("voice-inbox-sync", JSON.stringify(config));
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
    const entry = createEntry(text);
    setEntries((current) => [entry, ...current]);
    if (status === "Erledigt") setStatus("Offen");
    draftRef.current = ""; setDraft("");
  }
  function deleteEntry(id: string) {
    const stamp = new Date().toISOString();
    setEntries((current) => current.map((item) => item.id === id ? { ...item, deletedAt: stamp, updatedAt: stamp } : item));
  }
  function updateEntry(id: string, patch: Partial<Entry>) {
    setEntries((current) => current.map((item) => item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item));
  }
  function toggleDone(entry: Entry) {
    updateEntry(entry.id, { done: !entry.done });
    if (!entry.done) flash("Erledigt ✓");
  }
  function saveEdit() {
    if (!editing) return;
    const text = editing.text.trim();
    const original = entriesRef.current.find((item) => item.id === editing.id);
    if (text && original && text !== original.text) updateEntry(editing.id, { text, dueAt: original.dueAt ?? parseDue(text) });
    setEditing(null);
  }
  function changeDue(id: string, dueAt: string | undefined) {
    updateEntry(id, { dueAt });
    setDueEditId(null);
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
  function download(content: string, type: string, filename: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url; link.download = filename; link.click();
    URL.revokeObjectURL(url);
  }
  function exportMarkdown() {
    download(toMarkdown(activeEntries), "text/markdown", "voice-inbox.md");
    flash(`${activeEntries.length} Einträge als Markdown exportiert`);
  }
  function exportJson() {
    download(JSON.stringify(activeEntries, null, 2), "application/json", "voice-inbox-export.json");
    flash(`${activeEntries.length} Einträge exportiert`);
  }
  function importJson(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as unknown;
        if (!Array.isArray(parsed) && !(parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries))) throw new Error("kein Array");
        // Import ergänzt den Bestand (Merge über id + updatedAt) statt ihn zu ersetzen.
        const imported = normalizeEntries(parsed);
        setEntries((current) => mergeEntries(current, imported));
        flash(`${imported.length} Einträge importiert`);
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
    addEntry: (text) => setEntries((current) => [createEntry(text), ...current]),
    deleteMatching: (match) => {
      const needle = match.toLowerCase();
      const count = entriesRef.current.filter((entry) => !entry.deletedAt && entry.text.toLowerCase().includes(needle)).length;
      if (count) { const stamp = new Date().toISOString(); setEntries((current) => current.map((entry) => !entry.deletedAt && entry.text.toLowerCase().includes(needle) ? { ...entry, deletedAt: stamp, updatedAt: stamp } : entry)); }
      return count;
    },
    deleteLatest: (kind) => {
      const target = latestEntry(entriesRef.current, kind);
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
    completeMatching: (match) => {
      const needle = match.toLowerCase();
      const hits = entriesRef.current.filter((entry) => !entry.deletedAt && !entry.done && entry.text.toLowerCase().includes(needle));
      hits.forEach((entry) => updateEntry(entry.id, { done: true }));
      return hits.length;
    },
    completeLatest: (kind) => {
      const target = latestEntry(entriesRef.current.filter((entry) => !entry.done), kind);
      if (!target) return null;
      updateEntry(target.id, { done: true });
      return { text: target.text, kind: target.kind };
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

  const emptyLabel = activeEntries.length === 0 ? "Noch keine Einträge." : status === "Erledigt" ? "Noch nichts erledigt." : status === "Offen" && !query && filter === "Alle" ? "Alles erledigt. 🎉" : "Keine passenden Einträge.";

  function entryBody(entry: Entry, className: string) {
    if (editing?.id === entry.id) {
      return <div className="editBox">
        <textarea value={editing.text} onChange={(event) => setEditing({ id: entry.id, text: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) saveEdit(); if (event.key === "Escape") setEditing(null); }} aria-label="Eintrag bearbeiten" />
        <div><button onClick={saveEdit}>Speichern</button><button className="secondary" onClick={() => setEditing(null)}>Abbrechen</button></div>
      </div>;
    }
    return <p className={className}>{entry.text}</p>;
  }
  function entryActions(entry: Entry) {
    return <>
      <button className="ghost" onClick={() => setEditing({ id: entry.id, text: entry.text })} aria-label="Bearbeiten" title="Bearbeiten">✎</button>
      <button className="ghost" onClick={() => setDueEditId(dueEditId === entry.id ? null : entry.id)} aria-label="Fälligkeit setzen" title="Fälligkeit setzen">◷</button>
      <button className="ghost" onClick={() => copyEntry(entry)} aria-label="Kopieren" title="Kopieren">{copiedId === entry.id ? "✓" : "⧉"}</button>
      <button className="ghost" onClick={() => deleteEntry(entry.id)} aria-label="Löschen" title="Löschen">×</button>
    </>;
  }
  function dueChip(entry: Entry) {
    if (!entry.dueAt) return null;
    const state = entry.done ? "done" : dueState(entry.dueAt, now);
    return <button className={`due ${state}`} onClick={() => setDueEditId(dueEditId === entry.id ? null : entry.id)} aria-label={`Fällig ${formatDue(entry.dueAt, now)}, ändern`} title="Fälligkeit ändern">◷ {formatDue(entry.dueAt, now)}</button>;
  }
  function dueEditor(entry: Entry) {
    if (dueEditId !== entry.id) return null;
    return <div className="dueEditor">
      <input type="datetime-local" value={dueToInput(entry.dueAt)} onChange={(event) => updateEntry(entry.id, { dueAt: inputToDue(event.target.value) })} aria-label="Fällig am" />
      <button onClick={() => changeDue(entry.id, snoozeDue(entry.dueAt, 1, now))}>+1 Tag</button>
      <button onClick={() => changeDue(entry.id, snoozeDue(entry.dueAt, 7, now))}>+1 Woche</button>
      {entry.dueAt && <button className="secondary" onClick={() => changeDue(entry.id, undefined)}>Entfernen</button>}
      <button className="secondary" onClick={() => setDueEditId(null)} aria-label="Fälligkeit schließen">Fertig</button>
    </div>;
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
        <div className="viewToggle" role="group" aria-label="Status filtern">
          {(["Offen", "Erledigt", "Gesamt"] as const).map((item) => <button key={item} className={status === item ? "active" : ""} onClick={() => setStatus(item)} aria-pressed={status === item}>{item}{item === "Erledigt" && doneCount > 0 && <span className="count">{doneCount}</span>}</button>)}
        </div>
        <div className="viewToggle" role="group" aria-label="Ansicht umschalten">
          <button className={view === "cards" ? "active" : ""} onClick={() => setView("cards")} aria-pressed={view === "cards"} aria-label="Kartenansicht">▦ Karten</button>
          <button className={view === "list" ? "active" : ""} onClick={() => setView("list")} aria-pressed={view === "list"} aria-label="Listenansicht">☰ Liste</button>
        </div>
      </div>
      {view === "cards"
        ? <div className="grid">{visible.map((entry) => <article key={entry.id} className={`card ${entry.done ? "isDone" : ""}`}>
            <div className="cardTop">
              <div className="cardTags">
                <button className={`check ${entry.done ? "on" : ""}`} onClick={() => toggleDone(entry)} aria-label={entry.done ? "Wieder öffnen" : "Als erledigt markieren"} aria-pressed={!!entry.done}>{entry.done ? "✓" : ""}</button>
                <button className={`tag ${colors[entry.kind]}`} onClick={() => cycleKind(entry.id)} title="Kategorie ändern" aria-label={`Kategorie ${entry.kind}, klicken zum Ändern`}>{entry.kind}</button>
              </div>
              <div className="cardActions">{entryActions(entry)}</div>
            </div>
            {entryBody(entry, "entryText")}
            <footer><span>{formatCreated(entry, now)}</span>{dueChip(entry)}</footer>
            {dueEditor(entry)}
          </article>)}{visible.length === 0 && <div className="empty">{emptyLabel}</div>}</div>
        : <div className="list">{visible.map((entry) => <div key={entry.id} className={`row ${entry.done ? "isDone" : ""}`}>
            <button className={`check ${entry.done ? "on" : ""}`} onClick={() => toggleDone(entry)} aria-label={entry.done ? "Wieder öffnen" : "Als erledigt markieren"} aria-pressed={!!entry.done}>{entry.done ? "✓" : ""}</button>
            <button className={`tag ${colors[entry.kind]}`} onClick={() => cycleKind(entry.id)} title="Kategorie ändern" aria-label={`Kategorie ${entry.kind}, klicken zum Ändern`}>{entry.kind}</button>
            {entryBody(entry, "rowText")}
            {dueChip(entry)}
            <span className="rowMeta">{formatCreated(entry, now)}</span>
            {entryActions(entry)}
            {dueEditor(entry)}
          </div>)}{visible.length === 0 && <div className="empty">{emptyLabel}</div>}</div>}
      <div className="dataBar">
        <button onClick={exportJson} disabled={activeEntries.length === 0}>Export als JSON</button>
        <button onClick={exportMarkdown} disabled={activeEntries.length === 0}>Export als Markdown</button>
        <button onClick={() => fileInputRef.current?.click()}>Import aus JSON</button>
        <input ref={fileInputRef} type="file" accept="application/json,.json" hidden aria-label="JSON-Datei importieren" onChange={(event) => { const file = event.target.files?.[0]; if (file) importJson(file); event.target.value = ""; }} />
        {notice && <span className="notice" role="status">{notice}</span>}
      </div>
    </section>
    {syncOpen && <div className="modalBackdrop"><button type="button" className="modalScrim" tabIndex={-1} aria-label="Dialog schließen" onClick={() => setSyncOpen(false)} /><form className="syncModal" autoComplete="on" onSubmit={(event) => { event.preventDefault(); saveSyncConfig(); }}><button type="button" className="modalClose" onClick={() => setSyncOpen(false)} aria-label="Schließen">×</button><span className="tag green">Eigener Server</span><h2>VPS-Synchronisierung</h2><p>URL und Token werden nur lokal in diesem Browser gespeichert. Die Einträge gehen ausschließlich an deinen VPS.</p><label htmlFor="sync-server">API-Adresse<input id="sync-server" name="username" type="text" inputMode="url" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="https://strato-vpc.…ts.net:8443" value={syncConfig.url} onChange={(event) => setSyncConfig({ ...syncConfig, url: event.target.value })}/></label><label htmlFor="sync-token">Zugangs-Token<input id="sync-token" name="password" type="password" autoComplete="current-password" placeholder="Token vom VPS" value={syncConfig.token} onChange={(event) => setSyncConfig({ ...syncConfig, token: event.target.value })}/></label><button type="submit" className="saveSync">Speichern & synchronisieren</button></form></div>}
  </main>;
}

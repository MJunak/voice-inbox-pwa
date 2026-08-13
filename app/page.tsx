"use client";
import { useEffect, useMemo, useRef, useState } from "react";

type Kind = "Aufgabe" | "Termin" | "Notiz" | "Idee";
type Entry = { id: string; kind: Kind; text: string; created: string };
type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type Recognition = { lang: string; continuous: boolean; interimResults: boolean; onresult: ((event: { results: ArrayLike<SpeechResult> }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void };
type RecognitionConstructor = new () => Recognition;

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
  const recognitionRef = useRef<Recognition | null>(null);
  const draftRef = useRef("");
  const wantsToListenRef = useRef(false);
  const sessionStartRef = useRef("");

  useEffect(() => {
    const loadTimer = window.setTimeout(() => { setEntries(readStoredEntries()); setLoaded(true); }, 0);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
    return () => { window.clearTimeout(loadTimer); wantsToListenRef.current = false; recognitionRef.current?.stop(); };
  }, []);
  useEffect(() => { if (loaded) localStorage.setItem("voice-inbox-entries", JSON.stringify(entries)); }, [entries, loaded]);

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
    setEntries((current) => [{ id: crypto.randomUUID(), kind: classify(text), text, created: "Gerade eben" }, ...current]); draftRef.current = ""; setDraft("");
  }

  return <main>
    <header className="topbar"><a className="brand" href="./"><span className="logo">V</span><span>Voice Inbox</span></a><a className="inboxLink" href="#inbox">Inbox <b>{entries.length}</b></a></header>
    <section className="hero">
      <div className="eyebrow">DEINE GEDANKEN. FESTGEHALTEN.</div><h1>Sprich es aus.<br/><em>In deinem Tempo.</em></h1>
      <p>Nimm auch längere Gedanken am Stück auf und bearbeite den Text,<br/>bevor du ihn in deiner Inbox ablegst.</p>
      <div className={`composer ${listening ? "isListening" : ""}`}>
        <div className="composerHead"><div><strong>Neuer Eintrag</strong><span>{listening ? "Aufnahme läuft – sprich einfach weiter" : "Aufnehmen oder direkt losschreiben"}</span></div><button className="mic" onClick={toggleListening} aria-label={listening ? "Aufnahme stoppen" : "Aufnahme starten"}><span>{listening ? "■" : "●"}</span>{listening ? "Stoppen" : "Aufnehmen"}</button></div>
        <textarea value={draft} onChange={(event) => { draftRef.current = event.target.value; setDraft(event.target.value); }} placeholder="Hier entsteht dein Text …" aria-label="Text für einen neuen Inbox-Eintrag" />
        <div className="composerBottom"><span>{draft.length ? `${draft.length} Zeichen` : "Du kannst den erkannten Text jederzeit bearbeiten."}</span><button onClick={addEntry} disabled={!draft.trim()}>In Inbox ablegen <span>→</span></button></div>
      </div>
    </section>
    <section className="inbox" id="inbox">
      <div className="sectionHead"><div><h2>Deine Inbox</h2><p>Alles, was du zuletzt festgehalten hast.</p></div><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="⌕  Durchsuchen …" aria-label="Inbox durchsuchen" /></div>
      <div className="filters">{(["Alle", "Aufgabe", "Termin", "Notiz", "Idee"] as const).map((item) => <button className={filter === item ? "active" : ""} onClick={() => setFilter(item)} key={item}>{item}{item === "Alle" && <span>{entries.length}</span>}</button>)}</div>
      <div className="grid">{visible.map((entry) => <article key={entry.id} className="card"><div className="cardTop"><span className={`tag ${colors[entry.kind]}`}>{entry.kind}</span><button onClick={() => setEntries((current) => current.filter((item) => item.id !== entry.id))} aria-label="Löschen">×</button></div><p className="entryText">{entry.text}</p><footer><span>{entry.created}</span></footer></article>)}{visible.length === 0 && <div className="empty">Hier ist noch nichts. Sprich deinen ersten Gedanken ein.</div>}</div>
    </section>
  </main>;
}

"use client";

import { useEffect, useMemo, useState } from "react";

type Kind = "Aufgabe" | "Termin" | "Notiz" | "Idee";
type Entry = { id: string; kind: Kind; title: string; detail: string; created: string };

const seed: Entry[] = [
  { id: "1", kind: "Aufgabe", title: "Testplan fertigstellen", detail: "Vor dem Termin mit Daniel abschließen", created: "Heute, 10:24" },
  { id: "2", kind: "Termin", title: "Migration mit Daniel", detail: "Morgen · 15:00 Uhr", created: "Heute, 10:22" },
  { id: "3", kind: "Idee", title: "Automatische Smoke Tests", detail: "End-to-End-Prozesse als wiederholbare Tests erfassen", created: "Gestern" },
];

const colors: Record<Kind, string> = { Aufgabe: "blue", Termin: "orange", Notiz: "violet", Idee: "green" };

function classify(text: string): Kind {
  const t = text.toLowerCase();
  if (/morgen|uhr|termin|treffen|montag|dienstag|mittwoch|donnerstag|freitag/.test(t)) return "Termin";
  if (/muss|erledigen|machen|aufgabe|todo|erinner/.test(t)) return "Aufgabe";
  if (/idee|vielleicht|könnte|vorschlag/.test(t)) return "Idee";
  return "Notiz";
}

export default function Home() {
  const [entries, setEntries] = useState<Entry[]>(seed);
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [filter, setFilter] = useState<"Alle" | Kind>("Alle");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const stored = localStorage.getItem("voice-inbox-entries");
    if (stored) setEntries(JSON.parse(stored));
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
    }
  }, []);

  useEffect(() => { localStorage.setItem("voice-inbox-entries", JSON.stringify(entries)); }, [entries]);

  const visible = useMemo(() => entries.filter(e =>
    (filter === "Alle" || e.kind === filter) && `${e.title} ${e.detail}`.toLowerCase().includes(query.toLowerCase())
  ), [entries, filter, query]);

  function toggleListening() {
    if (listening) return setListening(false);
    const SpeechRecognition = (window as unknown as { webkitSpeechRecognition?: new () => any; SpeechRecognition?: new () => any }).SpeechRecognition
      || (window as unknown as { webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition;
    if (!SpeechRecognition) { alert("Spracherkennung wird in diesem Browser nicht unterstützt. Nutze Chrome oder Edge."); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = "de-DE"; recognition.continuous = true; recognition.interimResults = true;
    recognition.onresult = (event: any) => {
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i++) text += event.results[i][0].transcript;
      setDraft(text.trim());
    };
    recognition.onend = () => setListening(false);
    recognition.start(); setListening(true);
  }

  function addEntry() {
    const text = draft.trim(); if (!text) return;
    const kind = classify(text);
    setEntries([{ id: crypto.randomUUID(), kind, title: text.length > 58 ? `${text.slice(0, 58)}…` : text, detail: "Automatisch lokal erkannt · bitte prüfen", created: "Gerade eben" }, ...entries]);
    setDraft(""); setListening(false);
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#"><span className="logo">V</span><span>Voice Inbox</span></a>
        <nav><button className="navActive">Inbox <b>{entries.length}</b></button><button>Sammlung</button><button>Einstellungen</button></nav>
        <div className="local"><span /> Lokal & privat</div>
      </header>

      <section className="hero">
        <div className="eyebrow">DEINE GEDANKEN. SORTIERT.</div>
        <h1>Sprich es aus.<br/><em>Wir ordnen es ein.</em></h1>
        <p>Gedanken, Aufgaben und Termine – direkt aus deiner Stimme.<br/>Alles bleibt auf diesem Gerät.</p>

        <div className={`recorder ${listening ? "isListening" : ""}`}>
          <button className="mic" onClick={toggleListening} aria-label={listening ? "Aufnahme stoppen" : "Aufnahme starten"}>{listening ? "■" : "●"}</button>
          <div className="draft">
            <textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder={listening ? "Ich höre zu …" : "Tippe hier oder starte die Aufnahme …"} />
            <div className="recorderBottom"><span>{listening ? "Aufnahme läuft" : "Bereit zum Aufnehmen"}</span><button onClick={addEntry} disabled={!draft.trim()}>Einordnen <span>→</span></button></div>
          </div>
        </div>
        <div className="privacy">◉ Keine Cloud · Keine Anmeldung · Lokal gespeichert</div>
      </section>

      <section className="inbox">
        <div className="sectionHead"><div><h2>Deine Inbox</h2><p>Alles, was du zuletzt festgehalten hast.</p></div><input value={query} onChange={e => setQuery(e.target.value)} placeholder="⌕  Durchsuchen …" /></div>
        <div className="filters">{(["Alle", "Aufgabe", "Termin", "Notiz", "Idee"] as const).map(f => <button className={filter === f ? "active" : ""} onClick={() => setFilter(f)} key={f}>{f}{f === "Alle" && <span>{entries.length}</span>}</button>)}</div>
        <div className="grid">
          {visible.map(entry => <article key={entry.id} className="card">
            <div className="cardTop"><span className={`tag ${colors[entry.kind]}`}>{entry.kind}</span><button onClick={() => setEntries(entries.filter(e => e.id !== entry.id))} aria-label="Löschen">×</button></div>
            <h3>{entry.title}</h3><p>{entry.detail}</p><footer><span>{entry.created}</span><button>Öffnen →</button></footer>
          </article>)}
          {visible.length === 0 && <div className="empty">Hier ist noch nichts. Sprich deinen ersten Gedanken ein.</div>}
        </div>
      </section>
    </main>
  );
}

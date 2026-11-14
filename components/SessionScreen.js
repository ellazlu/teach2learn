'use client';

import { useEffect, useRef, useState } from 'react';
import { formatTime } from '../lib/client';

const CHUNK_MS = 15000; // how often new speech is sent to the note-taker
const MIN_WORDS = 8; // don't bother the note-taker with tiny fragments

export default function SessionScreen({ plan, level, timeLimitSec, onFinish, onExit }) {
  const [phase, setPhase] = useState('ready'); // ready | live | finishing
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [notes, setNotes] = useState([]);
  const [remaining, setRemaining] = useState(timeLimitSec);
  const [pending, setPending] = useState(0);
  const [micState, setMicState] = useState('off'); // off | on | unsupported | blocked
  const [typed, setTyped] = useState('');
  const [noteError, setNoteError] = useState('');

  // Refs hold the live values so timers and speech callbacks never read stale state.
  const transcriptRef = useRef('');
  const interimRef = useRef('');
  const notesRef = useRef([]);
  const sentUpToRef = useRef(0);
  const queueRef = useRef(Promise.resolve());
  const recRef = useRef(null);
  const listeningRef = useRef(false);
  const startedAtRef = useRef(0);
  const finishingRef = useRef(false);
  const timersRef = useRef({});
  const notebookRef = useRef(null);
  const transcriptBoxRef = useRef(null);

  useEffect(() => () => stopEverything(), []); // cleanup if the screen unmounts

  useEffect(() => {
    const el = notebookRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [notes]);

  useEffect(() => {
    const el = transcriptBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, interim]);

  function appendFinal(text) {
    const t = text.trim();
    if (!t) return;
    transcriptRef.current += (transcriptRef.current ? ' ' : '') + t;
    setTranscript(transcriptRef.current);
  }

  // Send everything said since the last chunk to the note-taker. Calls are
  // queued so notes always arrive in order.
  function sendChunk(force) {
    const full = transcriptRef.current;
    const newSpeech = full.slice(sentUpToRef.current).trim();
    if (!newSpeech) return;
    if (!force && newSpeech.split(/\s+/).length < MIN_WORDS) return;
    const contextTail = full.slice(Math.max(0, sentUpToRef.current - 400), sentUpToRef.current);
    sentUpToRef.current = full.length;

    queueRef.current = queueRef.current.then(async () => {
      setPending((p) => p + 1);
      try {
        const res = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            levelId: level.id,
            newSpeech,
            contextTail,
            recentNotes: notesRef.current.slice(-8),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Note-taker error');
        notesRef.current = [...notesRef.current, ...data.notes];
        setNotes(notesRef.current);
        setNoteError('');
      } catch (err) {
        setNoteError(`Note-taker hiccup: ${err.message}`);
      } finally {
        setPending((p) => p - 1);
      }
    });
  }

  function startMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setMicState('unsupported');
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onresult = (e) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) appendFinal(r[0].transcript);
        else live += r[0].transcript;
      }
      interimRef.current = live;
      setInterim(live);
    };
    rec.onerror = (e) => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) {
        listeningRef.current = false;
        setMicState('blocked');
      }
    };
    // Chrome stops listening after silence; restart until the session ends.
    rec.onend = () => {
      if (listeningRef.current) {
        try { rec.start(); } catch {}
      }
    };
    recRef.current = rec;
    listeningRef.current = true;
    try {
      rec.start();
      setMicState('on');
    } catch {
      setMicState('blocked');
    }
  }

  function stopMic() {
    listeningRef.current = false;
    try { recRef.current?.stop(); } catch {}
  }

  function stopEverything() {
    clearInterval(timersRef.current.tick);
    clearInterval(timersRef.current.chunk);
    stopMic();
  }

  function start() {
    setPhase('live');
    startedAtRef.current = Date.now();
    startMic();
    timersRef.current.tick = setInterval(() => {
      const left = timeLimitSec - (Date.now() - startedAtRef.current) / 1000;
      setRemaining(left);
      if (left <= 0) finish();
    }, 250);
    timersRef.current.chunk = setInterval(() => sendChunk(false), CHUNK_MS);
  }

  async function finish() {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setPhase('finishing');
    const timeUsedSec = Math.min(timeLimitSec, (Date.now() - startedAtRef.current) / 1000);
    stopEverything();
    await new Promise((r) => setTimeout(r, 800)); // let the last speech results arrive
    if (interimRef.current) appendFinal(interimRef.current);
    interimRef.current = '';
    setInterim('');
    sendChunk(true);
    await queueRef.current;
    onFinish({
      transcript: transcriptRef.current.trim(),
      notes: notesRef.current,
      timeUsedSec: Math.round(timeUsedSec),
    });
  }

  function cancel() {
    finishingRef.current = true;
    stopEverything();
    onExit();
  }

  function submitTyped(e) {
    e.preventDefault();
    appendFinal(typed);
    setTyped('');
  }

  if (phase === 'ready') {
    return (
      <div className="card center">
        <p className="eyebrow">{plan.topic_title}</p>
        <h2>Teach it to {level.who} {level.emoji}</h2>
        <p className="muted narrow">
          Talk out loud as if they're sitting in front of you. They won't talk back. They'll just take notes,
          and you'll be graded on what ends up in their notebook. You have {formatTime(timeLimitSec)}, and you can stop early.
        </p>
        <div className="row center-row">
          <button className="btn ghost" onClick={onExit}>← Back</button>
          <button className="btn big" onClick={start}>🎙️ Start</button>
        </div>
        <p className="muted small">Works best in Chrome. Allow microphone access when asked.</p>
      </div>
    );
  }

  const low = remaining <= 15;

  return (
    <div className="stack">
      <div className="session-bar card">
        <div>
          <span className={`timer ${low ? 'low' : ''}`}>{formatTime(remaining)}</span>
          <span className="muted"> left · teaching {level.emoji} {level.label}</span>
        </div>
        <div className="row">
          {micState === 'on' && phase === 'live' && <span className="rec-dot">● listening</span>}
          <button className="link" onClick={cancel} disabled={phase === 'finishing'}>Cancel</button>
          <button className="btn danger" onClick={finish} disabled={phase === 'finishing'}>
            {phase === 'finishing' ? 'Wrapping up…' : '■ Stop & grade'}
          </button>
        </div>
      </div>

      {micState === 'unsupported' && (
        <p className="warning">This browser doesn't support speech recognition. Use Chrome, or type your lesson below.</p>
      )}
      {micState === 'blocked' && (
        <p className="warning">Microphone is blocked. Allow mic access in the address bar, or type your lesson below.</p>
      )}

      <div className="two-col">
        <section className="card panel">
          <h3>🗣️ What you're saying</h3>
          <div className="transcript" ref={transcriptBoxRef}>
            {transcript || interim ? (
              <>
                {transcript} <span className="interim">{interim}</span>
              </>
            ) : (
              <span className="muted">Start talking…</span>
            )}
          </div>
          <form className="type-instead" onSubmit={submitTyped}>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Type instead (press Enter)"
              disabled={phase === 'finishing'}
            />
          </form>
        </section>

        <section className="card panel notebook-card">
          <h3>📓 Learner's notebook {pending > 0 && <span className="writing">✏️ writing…</span>}</h3>
          <ul className="notebook" ref={notebookRef}>
            {notes.length === 0 && <li className="muted">The learner writes notes every ~15 seconds.</li>}
            {notes.map((n, i) => <Note key={i} note={n} />)}
          </ul>
          {noteError && <p className="error small">{noteError}</p>}
        </section>
      </div>
    </div>
  );
}

export function Note({ note }) {
  if (note.kind === 'lost') {
    return <li className="note lost">😕 Lost me: “{note.text}”</li>;
  }
  return <li className={`note ${note.verbatim ? 'verbatim' : ''}`}>{note.verbatim ? `“${note.text}”` : note.text}</li>;
}

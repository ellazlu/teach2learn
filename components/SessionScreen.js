'use client';

import { useEffect, useRef, useState } from 'react';
import Avatar, { behaviorLabel } from './Avatar';
import StudentPanel from './StudentPanel';
import { formatTime, postJSON } from '../lib/client';
import { SessionEngine } from '../lib/student/engine.ts';
import { fmt } from '../lib/student/speech.ts';
import { createPlayer } from '../lib/voice';

// Streams the student's reply text; calls onText for each chunk.
async function streamReply(body, onText, signal) {
  const res = await fetch('/api/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Reply failed (${res.status})`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const t = dec.decode(value, { stream: true });
    full += t;
    onText(t);
  }
  return full;
}

// The live session. Browser plumbing only (mic, audio, timer); all student
// logic lives in SessionEngine.
export default function SessionScreen({ setup, level, extraction, onExtraction, onFinish, onExit }) {
  const timeLimitSec = setup.timeLimitSec;

  const [snap, setSnap] = useState(null);
  const [phase, setPhase] = useState('live'); // live | finishing
  const [remaining, setRemaining] = useState(timeLimitSec);
  const [interim, setInterim] = useState('');
  const [micState, setMicState] = useState('off'); // off | on | unsupported | blocked
  const [questionsOn, setQuestionsOn] = useState(true);
  const [extractState, setExtractState] = useState(extraction ? 'ready' : 'loading');
  const [extractError, setExtractError] = useState('');
  const [voiceNote, setVoiceNote] = useState('');
  const [typed, setTyped] = useState('');

  const engineRef = useRef(null);
  const playerRef = useRef(null);
  const recRef = useRef(null);
  const micOnRef = useRef(false);
  const listeningRef = useRef(false);
  const studentTalkingRef = useRef(false); // mic results are ignored while true
  const pendingStopRef = useRef(null);
  const firstSeenRef = useRef(new Map());
  const interimRef = useRef('');
  const t0Ref = useRef(0);
  const pausedTotalRef = useRef(0);
  const pausedSinceRef = useRef(null);
  const finishingRef = useRef(false);
  const timersRef = useRef({});
  const convoRef = useRef(null);

  const now = () => (performance.now() - t0Ref.current) / 1000;
  const teachingElapsed = () => {
    const pausing = pausedSinceRef.current ? performance.now() - pausedSinceRef.current : 0;
    return (performance.now() - t0Ref.current - pausedTotalRef.current - pausing) / 1000;
  };

  useEffect(() => {
    start();
    return () => stopEverything();
  }, []);

  useEffect(() => {
    const el = convoRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap?.utterances.length, interim]);

  function start() {
    t0Ref.current = performance.now();
    const player = createPlayer({ level, now, onError: (m) => setVoiceNote(`Natural voice unavailable (${m}); using the browser voice.`) });
    playerRef.current = player;
    let gate = Promise.resolve();
    const engine = new SessionEngine(level.id, {
      evaluate: (body) => postJSON('/api/evaluate', body),
      verify: (body) => postJSON('/api/verify', body),
      reply: streamReply,
      voice: {
        begin: () => (gate = pauseMicForStudent()),
        sentence: (text) => player.sentence(text, gate),
        end: resumeMicAfterStudent,
        cancel: () => player.cancel(),
      },
      now,
      teachingNow: teachingElapsed,
      timeLimitSec,
      onChange: setSnap,
    });
    engineRef.current = engine;
    setSnap(engine.snapshot());
    if (extraction) engine.setExtraction(extraction);
    else loadExtraction();
    startMic();
    timersRef.current.tick = setInterval(tick, 100);
  }

  async function loadExtraction() {
    setExtractState('loading');
    setExtractError('');
    try {
      const ext = await postJSON('/api/prepare', { sources: setup.sources, topic: setup.topic, levelId: level.id, focus: setup.focus });
      onExtraction(ext);
      engineRef.current?.setExtraction(ext);
      setExtractState('ready');
    } catch (err) {
      setExtractState('failed');
      setExtractError(err.message);
    }
  }

  function tick() {
    const left = timeLimitSec - teachingElapsed();
    setRemaining(left);
    if (left <= 0) {
      finish();
      return;
    }
    engineRef.current?.tick();
  }

  // ---- Microphone -----------------------------------------------------------------

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
      if (recRef.current !== rec || studentTalkingRef.current) return;
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!firstSeenRef.current.has(i)) firstSeenRef.current.set(i, now());
        if (r.isFinal) engineRef.current?.onTeacherFinal(r[0].transcript, firstSeenRef.current.get(i), now());
        else live += r[0].transcript;
      }
      interimRef.current = live;
      setInterim(live);
      if (live.trim()) engineRef.current?.onTeacherInterim();
    };
    rec.onerror = (e) => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) {
        micOnRef.current = false;
        setMicState('blocked');
      }
    };
    rec.onend = () => {
      if (recRef.current !== rec) return;
      firstSeenRef.current = new Map();
      if (pendingStopRef.current) {
        pendingStopRef.current();
        return;
      }
      if (listeningRef.current && !studentTalkingRef.current && micOnRef.current) {
        try { rec.start(); } catch {}
      }
    };
    recRef.current = rec;
    listeningRef.current = true;
    try {
      rec.start();
      micOnRef.current = true;
      setMicState('on');
    } catch {
      setMicState('blocked');
    }
  }

  // The student is about to speak: stop the mic so its voice isn't transcribed,
  // and pause the teaching timer. Waits briefly for the mic to release.
  function pauseMicForStudent() {
    studentTalkingRef.current = true;
    pausedSinceRef.current = performance.now();
    interimRef.current = '';
    setInterim('');
    if (!micOnRef.current || !recRef.current) return Promise.resolve();
    return new Promise((resolve) => {
      pendingStopRef.current = resolve;
      try { recRef.current.stop(); } catch { resolve(); }
      setTimeout(resolve, 400);
    }).then(() => {
      pendingStopRef.current = null;
    });
  }

  function resumeMicAfterStudent() {
    if (pausedSinceRef.current) pausedTotalRef.current += performance.now() - pausedSinceRef.current;
    pausedSinceRef.current = null;
    studentTalkingRef.current = false;
    if (!finishingRef.current && listeningRef.current && micOnRef.current && recRef.current) {
      try { recRef.current.start(); } catch {}
    }
  }

  // ---- Ending --------------------------------------------------------------------------

  function stopEverything() {
    listeningRef.current = false;
    clearInterval(timersRef.current.tick);
    playerRef.current?.cancel();
    const rec = recRef.current;
    recRef.current = null;
    try { rec?.stop(); } catch {}
  }

  async function finish() {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setPhase('finishing');
    const timeUsedSec = Math.min(timeLimitSec, teachingElapsed());
    listeningRef.current = false;
    clearInterval(timersRef.current.tick);
    playerRef.current?.cancel();
    try { recRef.current?.stop(); } catch {}
    await new Promise((r) => setTimeout(r, 600)); // let the last words arrive
    const engine = engineRef.current;
    if (interimRef.current) engine.onTeacherFinal(interimRef.current, now(), now());
    interimRef.current = '';
    setInterim('');
    await engine.finish(8000);
    stopEverything();
    onFinish({
      extraction: engine.extraction,
      initialModel: engine.initialModel,
      finalModel: engine.model,
      events: engine.events,
      utterances: engine.utterances,
      latencies: engine.latencies,
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
    if (studentTalkingRef.current || !typed.trim()) return;
    const t = now();
    engineRef.current?.onTeacherFinal(typed, t, t); // no measured duration: excluded from pace
    setTyped('');
  }

  function toggleQuestions() {
    const on = !questionsOn;
    setQuestionsOn(on);
    if (engineRef.current) engineRef.current.questionsEnabled = on;
  }

  // ---- UI ---------------------------------------------------------------------------------

  const speaking = !!snap?.speaking;
  const behavior = snap?.behavior || 'listening';
  const utterances = snap?.utterances || [];
  const status = phase === 'finishing' ? 'Wrapping up' : behaviorLabel(speaking ? 'responding' : behavior);
  const lastLatency = snap?.latencies?.[snap.latencies.length - 1];

  return (
    <div className="session">
      <div className="session-bar">
        <div className="session-meta">
          <span className={`timer ${remaining <= 15 ? 'low' : ''}`}>{formatTime(remaining)}</span>
          <span className="muted">
            Teaching a {level.label.toLowerCase()}
            {setup.topic ? ` · ${setup.topic}` : ''}
          </span>
        </div>
        <div className="session-actions">
          <label className="switch">
            <input type="checkbox" checked={questionsOn} onChange={toggleQuestions} />
            <span>Student questions</span>
          </label>
          <button className="btn-text" onClick={cancel} disabled={phase === 'finishing'}>Cancel</button>
          <button className="btn primary" onClick={finish} disabled={phase === 'finishing'}>
            {phase === 'finishing' ? 'Wrapping up…' : 'End session'}
          </button>
        </div>
      </div>

      {(micState === 'unsupported' || micState === 'blocked') && (
        <p className="notice">
          {micState === 'unsupported' ? "This browser doesn't support speech recognition. Use Chrome, or type below." : 'Microphone is blocked. Allow access in the address bar, or type below.'}
        </p>
      )}

      <div className="session-grid">
        <section className="stage">
          <Avatar behavior={behavior} speaking={speaking} thinking={!!snap?.thinking} />
          <p className="stage-status">
            {micState === 'on' && !speaking && phase === 'live' && <span className="live-dot" aria-hidden />}
            {status}
          </p>
          <p className={`caption ${speaking ? 'live' : ''}`} aria-live="polite">
            {snap?.caption || (utterances.length ? '' : 'Start explaining out loud. Your student will jump in when something needs clearing up.')}
          </p>
          {voiceNote && <p className="hint">{voiceNote}</p>}
        </section>

        <aside className="side">
          <StudentPanel model={snap?.model} loading={extractState === 'loading'} error={extractState === 'failed' ? extractError : ''} onRetry={loadExtraction} />
          <div className="transcript">
            <h3 className="label">Transcript</h3>
            <div className="convo" ref={convoRef}>
              {utterances.length === 0 && !interim && <p className="muted small">Your words appear here.</p>}
              {utterances.map((u) => <Turn key={u.id} u={u} />)}
              {interim && <p className="turn teacher interim"><span className="said">{interim}</span></p>}
            </div>
            <form onSubmit={submitTyped}>
              <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type here and press Enter" disabled={phase === 'finishing' || speaking} />
            </form>
          </div>
          <p className="debug">
            {snap?.lastDecision && <>Student: {snap.lastDecision}</>}
            {lastLatency !== undefined && <> · last reply {(lastLatency / 1000).toFixed(1)}s after you stopped</>}
            {snap?.lastError && <span className="error"> · {snap.lastError}</span>}
          </p>
        </aside>
      </div>
    </div>
  );
}

export function Turn({ u }) {
  return (
    <p className={`turn ${u.speaker === 'student' ? 'student' : 'teacher'}`}>
      <span className="ts">{fmt(u.start)}</span>
      <span className="who">{u.speaker === 'student' ? 'Student' : 'You'}</span>
      <span className="said">{u.text}</span>
    </p>
  );
}

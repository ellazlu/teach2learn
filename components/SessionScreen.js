'use client';

import { useEffect, useRef, useState } from 'react';
import Avatar, { behaviorLabel } from './Avatar';
import StudentPanel from './StudentPanel';
import { formatTime, postJSON } from '../lib/client';
import { SessionEngine } from '../lib/student/engine.ts';
import { fmt } from '../lib/student/speech.ts';

// The live session. Browser plumbing only: microphone (Web Speech API),
// text-to-speech, timer. All student logic lives in SessionEngine.
export default function SessionScreen({ setup, level, extraction, onExtraction, onFinish, onExit }) {
  const timeLimitSec = setup.timeLimitSec;

  const [snap, setSnap] = useState(null);
  const [phase, setPhase] = useState('live'); // live | finishing
  const [remaining, setRemaining] = useState(timeLimitSec);
  const [interim, setInterim] = useState('');
  const [bubble, setBubble] = useState(null); // { text, live }
  const [micState, setMicState] = useState('off'); // off | on | unsupported | blocked
  const [voiceOn, setVoiceOn] = useState(true);
  const [questionsOn, setQuestionsOn] = useState(true);
  const [extractState, setExtractState] = useState(extraction ? 'ready' : 'loading');
  const [extractError, setExtractError] = useState('');
  const [typed, setTyped] = useState('');

  const engineRef = useRef(null);
  const recRef = useRef(null);
  const micOnRef = useRef(false);
  const listeningRef = useRef(false); // session live; mic should run
  const pausedRef = useRef(false); // student is speaking; mic + timer paused
  const pendingStopRef = useRef(null);
  const firstSeenRef = useRef(new Map()); // result index -> time first heard
  const interimRef = useRef('');
  const t0Ref = useRef(0);
  const pausedTotalRef = useRef(0);
  const pausedSinceRef = useRef(null);
  const finishingRef = useRef(false);
  const voiceOnRef = useRef(true);
  const timersRef = useRef({});
  const cancelSpeechRef = useRef(null);
  const ttsActiveRef = useRef(false); // the student's voice is playing right now
  const convoRef = useRef(null);

  // Seconds since the session started (wall clock): used for all timestamps.
  const now = () => (performance.now() - t0Ref.current) / 1000;
  // Teaching time: excludes the time the student spends talking.
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
    const engine = new SessionEngine(level.id, {
      evaluate: (body) => postJSON('/api/evaluate', body),
      speak: (body) => postJSON('/api/speak', body),
      say,
      now,
      onChange: setSnap,
    });
    engineRef.current = engine;
    setSnap(engine.snapshot());
    if (extraction) engine.setExtraction(extraction);
    else loadExtraction();
    startMic();
    timersRef.current.tick = setInterval(tick, 250);
  }

  async function loadExtraction() {
    setExtractState('loading');
    setExtractError('');
    try {
      const ext = await postJSON('/api/prepare', {
        sources: setup.sources,
        topic: setup.topic,
        levelId: level.id,
        focus: setup.focus,
      });
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

  // ---- Microphone -------------------------------------------------------------

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
      if (recRef.current !== rec || ttsActiveRef.current) return;
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!firstSeenRef.current.has(i)) firstSeenRef.current.set(i, now());
        if (r.isFinal) {
          engineRef.current?.onTeacherFinal(r[0].transcript, firstSeenRef.current.get(i), now());
          setBubble((b) => (b && !b.live ? null : b)); // teacher is answering
        } else {
          live += r[0].transcript;
        }
      }
      interimRef.current = live;
      setInterim(live);
    };
    rec.onerror = (e) => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) {
        micOnRef.current = false;
        setMicState('blocked');
      }
    };
    rec.onend = () => {
      if (recRef.current !== rec) return;
      firstSeenRef.current = new Map(); // result indexes restart with each recognition session
      if (pendingStopRef.current) {
        pendingStopRef.current();
        return;
      }
      if (listeningRef.current && !pausedRef.current && micOnRef.current) {
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

  function resumeMic() {
    if (listeningRef.current && micOnRef.current && recRef.current) {
      try { recRef.current.start(); } catch {}
    }
  }

  // ---- The student's voice ---------------------------------------------------------

  // Called by the engine. Pauses the mic (so the student's voice can't be
  // transcribed as the teacher's), speaks, and reports real start/end times.
  async function say(text) {
    pausedRef.current = true;
    pausedSinceRef.current = performance.now();
    setBubble({ text, live: true });
    interimRef.current = '';
    setInterim('');
    if (micOnRef.current && recRef.current) {
      await new Promise((resolve) => {
        pendingStopRef.current = resolve;
        try { recRef.current.stop(); } catch { resolve(); }
        setTimeout(resolve, 1000);
      });
      pendingStopRef.current = null;
    }
    let start = now();
    let end = start;
    if (!finishingRef.current) {
      const timing = await speakAloud(text);
      start = timing.start;
      end = timing.end;
    }
    pausedTotalRef.current += performance.now() - pausedSinceRef.current;
    pausedSinceRef.current = null;
    pausedRef.current = false;
    setBubble((b) => (b ? { ...b, live: false } : b));
    if (!finishingRef.current) resumeMic();
    return { start, end };
  }

  function speakAloud(text) {
    ttsActiveRef.current = true;
    return new Promise((resolve) => {
      let start = now();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        ttsActiveRef.current = false;
        clearTimeout(timersRef.current.speak);
        cancelSpeechRef.current = null;
        resolve({ start, end: now() });
      };
      cancelSpeechRef.current = () => {
        try { window.speechSynthesis?.cancel(); } catch {}
        finish();
      };
      if (!voiceOnRef.current || !window.speechSynthesis) {
        timersRef.current.speak = setTimeout(finish, 2500); // time to read the bubble
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.pitch = level.voice.pitch;
      u.rate = level.voice.rate;
      u.onstart = () => (start = now());
      u.onend = finish;
      u.onerror = finish;
      timersRef.current.speak = setTimeout(finish, 2500 + text.split(/\s+/).length * 450); // safety net
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    });
  }

  // ---- Ending --------------------------------------------------------------------------

  function stopEverything() {
    listeningRef.current = false;
    clearInterval(timersRef.current.tick);
    clearTimeout(timersRef.current.speak);
    cancelSpeechRef.current?.();
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
    cancelSpeechRef.current?.();
    try { recRef.current?.stop(); } catch {}
    await new Promise((r) => setTimeout(r, 800)); // let the last words arrive
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
    if (pausedRef.current || !typed.trim()) return;
    const t = now();
    engineRef.current?.onTeacherFinal(typed, t, t); // no measured duration: excluded from pace
    setBubble((b) => (b && !b.live ? null : b));
    setTyped('');
    engineRef.current?.tick();
  }

  function toggleVoice() {
    voiceOnRef.current = !voiceOnRef.current;
    setVoiceOn(voiceOnRef.current);
  }

  function toggleQuestions() {
    const on = !questionsOn;
    setQuestionsOn(on);
    if (engineRef.current) engineRef.current.questionsEnabled = on;
  }

  // ---- UI ---------------------------------------------------------------------------------

  const speaking = !!snap?.speaking;
  const behavior = snap?.behavior || 'listening';
  const low = remaining <= 15;
  const utterances = snap?.utterances || [];

  return (
    <div className="stack">
      <div className="session-bar card">
        <div>
          <span className={`timer ${low ? 'low' : ''}`}>{formatTime(remaining)}</span>
          <span className="muted"> left{speaking && ' (paused while they talk)'}</span>
        </div>
        <div className="row">
          <button className={`chip small-chip ${voiceOn ? 'selected' : ''}`} onClick={toggleVoice}>
            {voiceOn ? '🔊 Voice on' : '🔇 Voice off'}
          </button>
          <button className={`chip small-chip ${questionsOn ? 'selected' : ''}`} onClick={toggleQuestions}>
            {questionsOn ? '🙋 Questions on' : '🤐 Questions off'}
          </button>
          <button className="link" onClick={cancel} disabled={phase === 'finishing'}>Cancel</button>
          <button className="btn danger" onClick={finish} disabled={phase === 'finishing'}>
            {phase === 'finishing' ? 'Wrapping up…' : '■ End session'}
          </button>
        </div>
      </div>

      {micState === 'unsupported' && <p className="warning">This browser doesn't support speech recognition. Use Chrome, or type below.</p>}
      {micState === 'blocked' && <p className="warning">Microphone is blocked. Allow mic access in the address bar, or type below.</p>}

      <section className="card stage">
        <div className="stage-avatar">
          <Avatar behavior={behavior} speaking={speaking} thinking={!!snap?.thinking} level={level} />
          <p className="stage-status">
            {micState === 'on' && !speaking && phase === 'live' && <span className="rec-dot">● </span>}
            {phase === 'finishing' ? 'Wrapping up…' : behaviorLabel(speaking ? 'responding' : behavior)}
          </p>
        </div>
        <div className="stage-right">
          <p className="eyebrow">Teaching {level.emoji} {level.label}</p>
          {bubble ? (
            <div className={`speech-bubble ${bubble.live ? 'live' : ''}`}>
              <p>{bubble.text}</p>
              {bubble.live && <button className="link small" onClick={() => cancelSpeechRef.current?.()}>skip</button>}
            </div>
          ) : (
            <p className="muted stage-hint">
              {utterances.length === 0
                ? "Start explaining out loud, like they're sitting in front of you. They'll ask questions when something doesn't click."
                : 'Keep going. Answer their questions when they ask.'}
            </p>
          )}
          {snap?.lastAction && <p className="muted tiny decision">Student's last decision: {snap.lastAction}</p>}
          {snap?.lastError && <p className="error small">{snap.lastError}</p>}
        </div>
      </section>

      <StudentPanel
        model={snap?.model}
        initialModel={snap?.initialModel}
        loading={extractState === 'loading'}
        error={extractState === 'failed' ? extractError : ''}
        onRetry={loadExtraction}
      />

      <section className="card">
        <h3 className="convo-title">Conversation</h3>
        <div className="convo" ref={convoRef}>
          {utterances.length === 0 && !interim && <p className="muted">Your words will appear here as you talk.</p>}
          {utterances.map((u) => <Turn key={u.id} u={u} level={level} />)}
          {interim && <p className="turn teacher interim">{interim}</p>}
        </div>
        <form className="type-instead" onSubmit={submitTyped}>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Type instead (press Enter)"
            disabled={phase === 'finishing' || speaking}
          />
        </form>
      </section>
    </div>
  );
}

export function Turn({ u, level }) {
  return (
    <p className={`turn ${u.speaker === 'student' ? 'learner' : 'teacher'}`}>
      <span className="ts">{fmt(u.start)}</span>
      {u.speaker === 'student' && <span className="who">{level.emoji}</span>} {u.text}
    </p>
  );
}

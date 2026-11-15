'use client';

import { useEffect, useRef, useState } from 'react';
import Avatar, { behaviorLabel } from './Avatar';
import StudentPanel from './StudentPanel';
import { formatTime, postJSON } from '../lib/client';
import { SessionEngine } from '../lib/student/engine.ts';
import { fmt } from '../lib/student/speech.ts';
import { createPlayer } from '../lib/voice';
import ConceptChecklist from './ConceptChecklist';
import Whiteboard from './Whiteboard';
import { MODE_NAME } from '../lib/learner/types.ts';
import { IDLE_MS, shouldAnalyze } from '../lib/learner/whiteboard.ts';

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
  // Teach to Learn only
  const study = setup.mode === 'student';
  const [manual, setManual] = useState([]);
  const [boardOpen, setBoardOpen] = useState(false);
  const [boardStatus, setBoardStatus] = useState('');
  const [boardBusy, setBoardBusy] = useState(false);
  const boardRef = useRef(null);
  const boardMeta = useRef({ analyzedVersion: -1, lastAutoAt: 0, inFlight: false, n: 0, idle: null });

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
      persona: setup.challenge?.scenario?.studentProfile || '',
      ...(study ? { mode: 'student', focusConceptIds: setup.practice ? [setup.practice.conceptId] : [], opening: setup.practice ? { text: setup.practice.prompt, conceptId: setup.practice.conceptId } : null } : {}),
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
      const ext = await postJSON('/api/prepare', {
        sources: setup.sources,
        topic: setup.topic,
        levelId: level.id,
        focus: setup.focus,
        misconception: setup.challenge?.scenario?.misconception || '',
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

  // ---- Whiteboard (Teach to Learn) -----------------------------------------------------------
  // Read only on share, after a pause in drawing, or at the end; never per stroke.

  async function analyzeBoard(trigger) {
    const wb = boardRef.current;
    const meta = boardMeta.current;
    const engine = engineRef.current;
    if (!wb || !engine?.model) return;
    const gate = { trigger, version: wb.version(), analyzedVersion: meta.analyzedVersion, lastAutoAt: meta.lastAutoAt, now: Date.now(), blank: wb.isBlank(), inFlight: meta.inFlight };
    if (!shouldAnalyze(gate)) {
      if (trigger === 'share' && gate.version === meta.analyzedVersion) setBoardStatus('The student has already seen this. Draw something new to share again.');
      return;
    }
    meta.inFlight = true;
    if (trigger !== 'end') setBoardBusy(true);
    if (trigger === 'pause') meta.lastAutoAt = Date.now();
    const version = gate.version;
    const recent = engine.utterances.filter((u) => u.speaker === 'teacher').slice(-3).map((u) => u.text).join(' ');
    try {
      const res = await postJSON('/api/whiteboard', {
        image: wb.snapshot(),
        mediaType: 'image/png',
        topic: engine.extraction?.topicTitle || setup.topic,
        concepts: engine.model.concepts.map((c) => ({ id: c.id, name: c.name })),
        recentSpeech: recent + (interimRef.current ? ` ${interimRef.current}` : ''),
        id: `w${++meta.n}`,
        at: now(),
        trigger,
      });
      meta.analyzedVersion = version;
      engine.addBoard({ ...res, thumb: wb.thumb() });
      setBoardStatus(res.blank ? '' : res.unclear?.length ? 'The student has a question about part of your drawing.' : trigger === 'share' ? 'The student is looking at your board.' : 'The student saw your board.');
    } catch (err) {
      setBoardStatus(`Couldn't read the board (${err.message}). The session continues.`);
    } finally {
      meta.inFlight = false;
      setBoardBusy(false);
    }
  }

  function onStrokeEnd() {
    const meta = boardMeta.current;
    clearTimeout(meta.idle);
    meta.idle = setTimeout(() => analyzeBoard('pause'), IDLE_MS);
  }

  function stopEverything() {
    clearTimeout(boardMeta.current.idle);
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
    if (study && boardRef.current) {
      clearTimeout(boardMeta.current.idle);
      // Final checkpoint: anything drawn since the last reading counts too (bounded wait).
      await Promise.race([analyzeBoard('end'), new Promise((r) => setTimeout(r, 7000))]);
    }
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
      ...(study ? { learner: engine.learner, boards: engine.boards, manualChecked: manual } : {}),
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
            <span className="mode-tag">{MODE_NAME[study ? 'student' : 'educator']}</span>
            {study ? `Explaining to a ${level.label.toLowerCase()}` : `Teaching a ${level.label.toLowerCase()}`}
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

      {study && setup.practice && (
        <p className="challenge-goal">
          <span className="label">Practice</span> {setup.practice.conceptName}
        </p>
      )}

      {setup.challenge && (
        <p className="challenge-goal">
          <span className="label">Challenge</span> {setup.challenge.goal}
        </p>
      )}

      {(micState === 'unsupported' || micState === 'blocked') && (
        <p className="notice">
          {micState === 'unsupported' ? "This browser doesn't support speech recognition. Use Chrome, or type below." : 'Microphone is blocked. Allow access in the address bar, or type below.'}
        </p>
      )}

      <div className="session-grid">
        <section className="stage">
          <Avatar behavior={behavior} speaking={speaking} thinking={!!snap?.thinking} level={level.id} />
          <p className="stage-status">
            {micState === 'on' && !speaking && phase === 'live' && <span className="live-dot" aria-hidden />}
            {status}
          </p>
          <p className={`caption ${speaking ? 'live' : ''}`} aria-live="polite">
            {snap?.caption || (utterances.length ? '' : study ? 'Start explaining the first idea on your checklist. The student will ask what it wants to understand.' : 'Start explaining out loud. Your student will jump in when something needs clearing up.')}
          </p>
          {voiceNote && <p className="hint">{voiceNote}</p>}
          {study && (
            <div className="wb-wrap">
              <button type="button" className="btn-text wb-toggle" aria-expanded={boardOpen} onClick={() => setBoardOpen((o) => !o)}>
                {boardOpen ? 'Hide whiteboard' : 'Use the whiteboard'}
              </button>
              {/* Kept mounted when hidden so the drawing survives collapsing. */}
              <div hidden={!boardOpen}>
                <Whiteboard ref={boardRef} onStrokeEnd={onStrokeEnd} onShare={() => analyzeBoard('share')} status={boardStatus} busy={boardBusy} disabled={phase === 'finishing' || !snap?.ready} />
              </div>
            </div>
          )}
        </section>

        <aside className="side">
          {study ? (
            <ConceptChecklist learner={snap?.learner} manual={manual} onToggle={(id) => setManual((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]))} />
          ) : (
            <StudentPanel model={snap?.model} loading={extractState === 'loading'} error={extractState === 'failed' ? extractError : ''} onRetry={loadExtraction} />
          )}
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

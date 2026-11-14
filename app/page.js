'use client';

import { useEffect, useRef, useState } from 'react';
import SetupScreen from '../components/SetupScreen';
import SessionScreen from '../components/SessionScreen';
import ResultsScreen from '../components/ResultsScreen';
import HistoryScreen from '../components/HistoryScreen';
import ProgressScreen from '../components/ProgressScreen';
import { postJSON } from '../lib/client';
import { getLevel } from '../lib/levels.ts';
import { loadHistory, saveHistory, attemptNumber, compactEvents, MAX_HISTORY } from '../lib/history.ts';
import { loadProfile, saveProfile, applyCoachResult, currentChallenge, historyForCoach } from '../lib/progress.ts';
import { scoreSession } from '../lib/coach/rubric.ts';
import { addRecordToProfile, backfillProfile, coachSummary, runLocalCoach } from '../lib/coach/record.ts';

// Screens: setup -> session -> feedback -> results
//          history -> history-detail, progress (any time you're not mid-session)
// After feedback is shown, the coach runs in the background and sets the next
// practice challenge; it never runs during a live session.
const BUSY = ['session', 'feedback'];

export default function Home() {
  const [screen, setScreen] = useState('setup');
  const [setup, setSetup] = useState(null); // { sources, topic, levelId, timeLimitSec, focus, topicId, challenge? }
  const [extraction, setExtraction] = useState(null);
  const [pending, setPending] = useState(null);
  const [currentId, setCurrentId] = useState(null);
  const [history, setHistory] = useState([]);
  const [profile, setProfile] = useState(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [viewingId, setViewingId] = useState(null);
  const [returnTo, setReturnTo] = useState('setup');
  const [error, setError] = useState('');
  const historyRef = useRef([]);
  const profileRef = useRef(null);
  const setupRef = useRef(null);
  setupRef.current = setup;

  useEffect(() => {
    historyRef.current = loadHistory();
    setHistory(historyRef.current);
    const p = backfillProfile(loadProfile(), [...historyRef.current].reverse());
    profileRef.current = p;
    setProfile(p);
    saveProfile(p);
  }, []);

  function updateHistory(fn) {
    const next = fn(historyRef.current);
    historyRef.current = next;
    setHistory(next);
    setSaveFailed(!saveHistory(next));
  }

  function updateProfile(fn) {
    const next = fn(profileRef.current);
    profileRef.current = next;
    setProfile(next);
    saveProfile(next);
  }

  const patchRecord = (id, patch) => updateHistory((h) => h.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  function startNewTopic(s) {
    setError('');
    setSetup({ ...s, topicId: `topic-${Date.now()}`, challenge: null });
    setExtraction(null);
    setCurrentId(null);
    setScreen('session');
  }

  // Launch the coach's scenario straight into a session.
  function startChallenge(ch) {
    const from = historyRef.current.find((r) => r.id === ch.fromSessionId);
    const prev = setupRef.current;
    const sameTopic = from && from.topicTitle === ch.scenario.topic;
    const reuseNotes = sameTopic && prev && prev.topicId === from.topicId;
    setError('');
    setSetup({
      topic: ch.scenario.topic,
      levelId: ch.scenario.levelId,
      timeLimitSec: ch.scenario.timeLimitSec,
      sources: reuseNotes ? prev.sources : [],
      focus: reuseNotes ? prev.focus : '',
      topicId: sameTopic ? from.topicId : `topic-${Date.now()}`,
      challenge: ch,
    });
    setExtraction(null); // re-extract so the scenario's misconception is included
    setCurrentId(null);
    setScreen('session');
  }

  async function runCoachFor(record) {
    patchRecord(record.id, { coach: { status: 'pending' } });
    const p = profileRef.current;
    const input = { session: record, history: historyForCoach(p, record.id), activeChallenge: currentChallenge(p), coachNotes: p.coachNotes || '' };
    let result;
    try {
      result = await postJSON('/api/coach', input);
    } catch (e) {
      // Service unreachable: run the same deterministic coach in the browser.
      try {
        result = await runLocalCoach(input, `Coach service unavailable (${e.message}); ran the deterministic coach in the browser.`);
      } catch (e2) {
        patchRecord(record.id, { coach: { status: 'failed', error: e2.message } });
        return;
      }
    }
    updateProfile((prof) => applyCoachResult(prof, result));
    patchRecord(record.id, { coach: coachSummary(result) });
  }

  async function getFeedback(sess) {
    const s = setupRef.current;
    setError('');
    setPending(sess);
    setScreen('feedback');
    try {
      const topicTitle = sess.extraction?.topicTitle || s.topic || 'Your lesson';
      const fb = await postJSON('/api/feedback', {
        levelId: s.levelId,
        topicTitle,
        initial: sess.initialModel,
        final: sess.finalModel,
        events: sess.events,
        utterances: sess.utterances,
      });
      const record = {
        version: 4,
        id: `s-${Date.now()}`,
        createdAt: new Date().toISOString(),
        topicId: s.topicId,
        topicTitle,
        levelId: s.levelId,
        timeLimitSec: s.timeLimitSec,
        timeUsedSec: sess.timeUsedSec,
        extraction: sess.extraction,
        initialModel: sess.initialModel,
        finalModel: sess.finalModel,
        events: compactEvents(sess.events),
        utterances: sess.utterances,
        metrics: fb.metrics,
        learning: fb.learning,
        concepts: fb.concepts,
        teaching: fb.teaching,
        evidence: fb.evidence,
        usedFallback: fb.usedFallback,
        latencies: sess.latencies || [],
        challengeId: s.challenge?.id || null,
        coach: { status: 'pending' },
      };
      record.ratings = scoreSession({
        levelId: record.levelId,
        utterances: record.utterances,
        events: record.events,
        metrics: record.metrics,
        evidence: record.evidence,
        finalModel: record.finalModel,
      });
      updateHistory((h) => [record, ...h].slice(0, MAX_HISTORY));
      updateProfile((p) => addRecordToProfile(p, record));
      setCurrentId(record.id);
      setScreen('results');
      runCoachFor(record); // background
    } catch (e) {
      setError(e.message);
    }
  }

  // Repeat the same lesson as a plain session (no challenge scenario).
  function teachAgain() {
    setSetup((s) => ({ ...s, challenge: null }));
    setScreen('session');
  }

  function openPage(name) {
    if (!['history', 'history-detail', 'progress'].includes(screen)) setReturnTo(screen);
    setScreen(name);
  }
  const back = () => setScreen(returnTo === 'results' && !current ? 'setup' : returnTo);

  function deleteEntry(id) {
    updateHistory((h) => h.filter((e) => e.id !== id));
    if (id === currentId) setCurrentId(null);
    if (id === viewingId) setScreen('history');
  }

  const level = setup ? getLevel(setup.levelId) : null;
  const current = history.find((e) => e.id === currentId);
  const viewing = history.find((e) => e.id === viewingId);
  const busy = BUSY.includes(screen);
  const challenges = profile?.challenges || [];
  const findChallenge = (id) => challenges.find((c) => c.id === id) || null;
  const active = profile ? currentChallenge(profile) : null;

  const resultsProps = (entry) => ({
    entry,
    attemptNumber: attemptNumber(history, entry),
    nextChallenge: findChallenge(entry.coach?.nextChallengeId),
    attemptedChallenge: findChallenge(entry.challengeId),
    onStartChallenge: startChallenge,
    onRetryCoach: () => runCoachFor(entry),
  });

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => !busy && setScreen('setup')} disabled={busy}>
          teach2learn
        </button>
        {!busy && (
          <nav className="topnav">
            {active && screen !== 'results' && (
              <button className="btn-text" onClick={() => startChallenge(active)}>Next challenge</button>
            )}
            <button className="btn-text" onClick={() => openPage('progress')}>Progress</button>
            <button className="btn-text" onClick={() => openPage('history')}>
              History{history.length > 0 && <span className="count">{history.length}</span>}
            </button>
          </nav>
        )}
      </header>

      <main className="main">
        {screen === 'setup' && <SetupScreen initial={setup} error={error} onSubmit={startNewTopic} />}

        {screen === 'session' && (
          <SessionScreen
            setup={setup}
            level={level}
            extraction={extraction}
            onExtraction={setExtraction}
            onFinish={getFeedback}
            onExit={() => setScreen(current ? 'results' : 'setup')}
          />
        )}

        {screen === 'feedback' && (
          <div className="center-block">
            {error ? (
              <>
                <h2>Couldn't build feedback</h2>
                <p className="error">{error}</p>
                <div className="row">
                  <button className="btn primary" onClick={() => getFeedback(pending)}>Retry</button>
                  <button className="btn" onClick={() => { setError(''); setScreen('session'); }}>Teach again</button>
                </div>
              </>
            ) : (
              <>
                <div className="spinner" aria-hidden />
                <p className="muted">Reviewing the session…</p>
              </>
            )}
          </div>
        )}

        {screen === 'results' && current && (
          <ResultsScreen
            {...resultsProps(current)}
            footer={
              <div className="footer-actions">
                <button className="btn-text" onClick={() => openPage('progress')}>See progress</button>
                <button className="btn" onClick={() => setScreen('setup')}>New topic</button>
                <button className="btn" onClick={teachAgain}>Teach it again</button>
              </div>
            }
          />
        )}

        {screen === 'progress' && profile && (
          <ProgressScreen
            profile={profile}
            onStartChallenge={startChallenge}
            onOpenSession={(id) => { if (history.some((h) => h.id === id)) { setViewingId(id); setScreen('history-detail'); } }}
            onBack={back}
          />
        )}

        {screen === 'history' && (
          <HistoryScreen
            history={history}
            saveFailed={saveFailed}
            onOpen={(id) => { setViewingId(id); setScreen('history-detail'); }}
            onDelete={deleteEntry}
            onClearAll={() => { updateHistory(() => []); setCurrentId(null); }}
            onBack={back}
          />
        )}

        {screen === 'history-detail' && viewing && (
          <ResultsScreen
            {...resultsProps(viewing)}
            isHistory
            footer={
              <div className="footer-actions">
                <button className="btn" onClick={() => setScreen('history')}>Back to history</button>
                <button className="btn-text" onClick={() => window.confirm('Delete this session?') && deleteEntry(viewing.id)}>Delete</button>
                {setup && viewing.topicId === setup.topicId && (
                  <button className="btn" onClick={teachAgain}>Teach it again</button>
                )}
              </div>
            }
          />
        )}
      </main>
    </div>
  );
}

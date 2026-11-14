'use client';

import { useEffect, useRef, useState } from 'react';
import SetupScreen from '../components/SetupScreen';
import OverviewScreen from '../components/OverviewScreen';
import SessionScreen from '../components/SessionScreen';
import ResultsScreen from '../components/ResultsScreen';
import HistoryScreen from '../components/HistoryScreen';
import { postJSON } from '../lib/client';
import { getLevel } from '../lib/levels';
import { loadHistory, saveHistory, attemptsFor, MAX_HISTORY } from '../lib/history';

// Screens: setup -> preparing -> overview -> session -> grading -> results
//          history -> history-detail (reachable from anywhere except mid-session)
const BUSY = ['preparing', 'session', 'grading'];

export default function Home() {
  const [screen, setScreen] = useState('setup');
  const [setup, setSetup] = useState(null); // { sources, levelId, timeLimitSec, focus }
  const [plan, setPlan] = useState(null); // the prepared plan, with plan.id
  const [session, setSession] = useState(null); // last session waiting to be graded
  const [currentId, setCurrentId] = useState(null); // history id of the latest result
  const [history, setHistory] = useState([]); // newest first
  const [saveFailed, setSaveFailed] = useState(false);
  const [viewingId, setViewingId] = useState(null);
  const [returnTo, setReturnTo] = useState('setup');
  const [error, setError] = useState('');
  const historyRef = useRef([]); // always-current copy for async handlers

  useEffect(() => {
    historyRef.current = loadHistory();
    setHistory(historyRef.current);
  }, []);

  function updateHistory(fn) {
    const next = fn(historyRef.current);
    historyRef.current = next;
    setHistory(next);
    setSaveFailed(!saveHistory(next));
  }

  async function prepare(s) {
    setError('');
    setSetup(s);
    setScreen('preparing');
    try {
      const p = await postJSON('/api/prepare', { sources: s.sources, levelId: s.levelId, focus: s.focus });
      setPlan({ ...p, id: `plan-${Date.now()}` });
      setCurrentId(null);
      setScreen('overview');
    } catch (e) {
      setError(e.message);
      setScreen('setup');
    }
  }

  async function gradeSession(sess) {
    setError('');
    setSession(sess);
    setScreen('grading');
    try {
      const grade = await postJSON('/api/grade', {
        sources: setup.sources,
        levelId: setup.levelId,
        plan,
        transcript: sess.transcript,
        notes: sess.notes,
      });
      const entry = {
        id: `s-${Date.now()}`,
        createdAt: new Date().toISOString(),
        planId: plan.id,
        levelId: setup.levelId,
        timeLimitSec: setup.timeLimitSec,
        plan,
        session: sess,
        grade,
      };
      updateHistory((h) => [entry, ...h].slice(0, MAX_HISTORY));
      setCurrentId(entry.id);
      setScreen('results');
    } catch (e) {
      setError(e.message);
    }
  }

  function openHistory() {
    if (screen !== 'history' && screen !== 'history-detail') setReturnTo(screen);
    setScreen('history');
  }

  function deleteEntry(id) {
    updateHistory((h) => h.filter((e) => e.id !== id));
    if (id === currentId) setCurrentId(null);
    if (id === viewingId) setScreen('history');
  }

  const level = setup ? getLevel(setup.levelId) : null;
  const current = history.find((e) => e.id === currentId);
  const viewing = history.find((e) => e.id === viewingId);
  const busy = BUSY.includes(screen);

  return (
    <main className="container">
      <header className="brand">
        <div className="brand-left" onClick={() => !busy && setScreen('setup')}>
          <span className="logo">teach2learn</span>
          <span className="tagline">Learn it by teaching it.</span>
        </div>
        {!busy && (
          <button className="btn ghost nav" onClick={openHistory}>
            🕘 History{history.length > 0 && ` (${history.length})`}
          </button>
        )}
      </header>

      {screen === 'setup' && <SetupScreen initial={setup} error={error} onSubmit={prepare} />}

      {screen === 'preparing' && (
        <Loading title="Reading your material…" subtitle="Building the overview and the rubric your learner will be graded on." />
      )}

      {screen === 'overview' && (
        <OverviewScreen
          plan={plan}
          level={level}
          timeLimitSec={setup.timeLimitSec}
          onBack={() => setScreen('setup')}
          onStart={() => setScreen('session')}
          onBackToResults={current ? () => setScreen('results') : null}
        />
      )}

      {screen === 'session' && (
        <SessionScreen
          plan={plan}
          level={level}
          timeLimitSec={setup.timeLimitSec}
          onFinish={gradeSession}
          onExit={() => setScreen('overview')}
        />
      )}

      {screen === 'grading' &&
        (error ? (
          <div className="card center">
            <h2>Grading failed</h2>
            <p className="error">{error}</p>
            <div className="row center-row">
              <button className="btn" onClick={() => gradeSession(session)}>Retry grading</button>
              <button className="btn ghost" onClick={() => { setError(''); setScreen('session'); }}>Teach again</button>
            </div>
          </div>
        ) : (
          <Loading title="Your learner is handing in their notes…" subtitle="Checking the notes against the rubric." />
        ))}

      {screen === 'results' && current && (
        <ResultsScreen
          entry={current}
          attempts={attemptsFor(history, current)}
          footer={
            <div className="row space-between">
              <div className="row">
                <button className="btn ghost" onClick={() => setScreen('setup')}>New topic</button>
                <button className="btn ghost" onClick={() => setScreen('overview')}>Review rubric</button>
              </div>
              <button className="btn big" onClick={() => setScreen('session')}>↻ Try again</button>
            </div>
          }
        />
      )}

      {screen === 'history' && (
        <HistoryScreen
          history={history}
          saveFailed={saveFailed}
          onOpen={(id) => { setViewingId(id); setScreen('history-detail'); }}
          onDelete={deleteEntry}
          onClearAll={() => { updateHistory(() => []); setCurrentId(null); }}
          onBack={() => setScreen(returnTo === 'results' && !current ? 'setup' : returnTo)}
        />
      )}

      {screen === 'history-detail' && viewing && (
        <ResultsScreen
          entry={viewing}
          attempts={attemptsFor(history, viewing)}
          isHistory
          footer={
            <div className="row space-between">
              <div className="row">
                <button className="btn ghost" onClick={() => setScreen('history')}>← Back to history</button>
                <button
                  className="btn ghost"
                  onClick={() => window.confirm('Delete this session?') && deleteEntry(viewing.id)}
                >
                  Delete
                </button>
              </div>
              {plan && viewing.planId === plan.id && (
                <button className="btn big" onClick={() => setScreen('session')}>↻ Teach this again</button>
              )}
            </div>
          }
        />
      )}
    </main>
  );
}

function Loading({ title, subtitle }) {
  return (
    <div className="card center">
      <div className="spinner" />
      <h2>{title}</h2>
      <p className="muted">{subtitle}</p>
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import SetupScreen from '../components/SetupScreen';
import SessionScreen from '../components/SessionScreen';
import ResultsScreen from '../components/ResultsScreen';
import HistoryScreen from '../components/HistoryScreen';
import { postJSON } from '../lib/client';
import { getLevel } from '../lib/levels.ts';
import { loadHistory, saveHistory, attemptNumber, compactEvents, MAX_HISTORY } from '../lib/history.ts';

// Screens: setup -> session -> feedback -> results
//          history -> history-detail (reachable whenever you're not mid-session)
const BUSY = ['session', 'feedback'];

export default function Home() {
  const [screen, setScreen] = useState('setup');
  const [setup, setSetup] = useState(null); // { sources, topic, levelId, timeLimitSec, focus, topicId }
  const [extraction, setExtraction] = useState(null); // concepts + misconceptions for this topic/level
  const [pending, setPending] = useState(null); // finished session waiting for feedback
  const [currentId, setCurrentId] = useState(null);
  const [history, setHistory] = useState([]); // newest first
  const [saveFailed, setSaveFailed] = useState(false);
  const [viewingId, setViewingId] = useState(null);
  const [returnTo, setReturnTo] = useState('setup');
  const [error, setError] = useState('');
  const historyRef = useRef([]);
  const setupRef = useRef(null);
  setupRef.current = setup;

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

  function startNewTopic(s) {
    setError('');
    setSetup({ ...s, topicId: `topic-${Date.now()}` });
    setExtraction(null);
    setCurrentId(null);
    setScreen('session');
  }

  async function getFeedback(sess) {
    const s = setupRef.current;
    setError('');
    setPending(sess);
    setScreen('feedback');
    try {
      const fb = await postJSON('/api/feedback', {
        levelId: s.levelId,
        topicTitle: sess.extraction?.topicTitle || s.topic || 'Your lesson',
        initial: sess.initialModel,
        final: sess.finalModel,
        events: sess.events,
        utterances: sess.utterances,
        sources: s.sources,
      });
      const record = {
        version: 3,
        id: `s-${Date.now()}`,
        createdAt: new Date().toISOString(),
        topicId: s.topicId,
        topicTitle: sess.extraction?.topicTitle || s.topic || 'Your lesson',
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
        feedback: {
          summary: fb.summary,
          suggestions: fb.suggestions,
          strengths: fb.strengths,
          outside_knowledge: fb.outside_knowledge,
          evidence: fb.evidence,
          usedFallback: fb.usedFallback,
        },
      };
      updateHistory((h) => [record, ...h].slice(0, MAX_HISTORY));
      setCurrentId(record.id);
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

      {screen === 'feedback' &&
        (error ? (
          <div className="card center">
            <h2>Couldn't get feedback</h2>
            <p className="error">{error}</p>
            <div className="row center-row">
              <button className="btn" onClick={() => getFeedback(pending)}>Retry</button>
              <button className="btn ghost" onClick={() => { setError(''); setScreen('session'); }}>Teach again</button>
            </div>
          </div>
        ) : (
          <div className="card center">
            <div className="spinner" />
            <h2>Reviewing your lesson…</h2>
            <p className="muted">Looking at what your student learned and the moments that mattered.</p>
          </div>
        ))}

      {screen === 'results' && current && (
        <ResultsScreen
          entry={current}
          attemptNumber={attemptNumber(history, current)}
          footer={
            <div className="row space-between">
              <button className="btn ghost" onClick={() => setScreen('setup')}>New topic</button>
              <button className="btn big" onClick={() => setScreen('session')}>↻ Teach it again</button>
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
          attemptNumber={attemptNumber(history, viewing)}
          isHistory
          footer={
            <div className="row space-between">
              <div className="row">
                <button className="btn ghost" onClick={() => setScreen('history')}>← Back to history</button>
                <button className="btn ghost" onClick={() => window.confirm('Delete this session?') && deleteEntry(viewing.id)}>Delete</button>
              </div>
              {setup && viewing.topicId === setup.topicId && (
                <button className="btn big" onClick={() => setScreen('session')}>↻ Teach it again</button>
              )}
            </div>
          }
        />
      )}
    </main>
  );
}

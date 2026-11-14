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
//          history -> history-detail (any time you're not mid-session)
const BUSY = ['session', 'feedback'];

export default function Home() {
  const [screen, setScreen] = useState('setup');
  const [setup, setSetup] = useState(null); // { sources, topic, levelId, timeLimitSec, focus, topicId }
  const [extraction, setExtraction] = useState(null);
  const [pending, setPending] = useState(null);
  const [currentId, setCurrentId] = useState(null);
  const [history, setHistory] = useState([]);
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
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => !busy && setScreen('setup')} disabled={busy}>
          teach2learn
        </button>
        {!busy && (
          <button className="btn-text" onClick={openHistory}>
            History{history.length > 0 && <span className="count">{history.length}</span>}
          </button>
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
            entry={current}
            attemptNumber={attemptNumber(history, current)}
            footer={
              <div className="footer-actions">
                <button className="btn" onClick={() => setScreen('setup')}>New topic</button>
                <button className="btn primary" onClick={() => setScreen('session')}>Teach it again</button>
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
              <div className="footer-actions">
                <button className="btn" onClick={() => setScreen('history')}>Back to history</button>
                <button className="btn-text" onClick={() => window.confirm('Delete this session?') && deleteEntry(viewing.id)}>Delete</button>
                {setup && viewing.topicId === setup.topicId && (
                  <button className="btn primary" onClick={() => setScreen('session')}>Teach it again</button>
                )}
              </div>
            }
          />
        )}
      </main>
    </div>
  );
}

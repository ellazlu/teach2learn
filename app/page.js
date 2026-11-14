'use client';

import { useState } from 'react';
import SetupScreen from '../components/SetupScreen';
import OverviewScreen from '../components/OverviewScreen';
import SessionScreen from '../components/SessionScreen';
import ResultsScreen from '../components/ResultsScreen';
import { postJSON } from '../lib/client';
import { getLevel } from '../lib/levels';

// Screens: setup -> preparing -> overview -> session -> grading -> results
export default function Home() {
  const [screen, setScreen] = useState('setup');
  const [setup, setSetup] = useState(null); // { sources, levelId, timeLimitSec, focus }
  const [plan, setPlan] = useState(null);
  const [session, setSession] = useState(null); // { transcript, notes, timeUsedSec }
  const [grade, setGrade] = useState(null);
  const [attempts, setAttempts] = useState([]);
  const [error, setError] = useState('');

  async function prepare(s) {
    setError('');
    setSetup(s);
    setScreen('preparing');
    try {
      const p = await postJSON('/api/prepare', { sources: s.sources, levelId: s.levelId, focus: s.focus });
      setPlan(p);
      setAttempts([]);
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
      const g = await postJSON('/api/grade', {
        sources: setup.sources,
        levelId: setup.levelId,
        plan,
        transcript: sess.transcript,
        notes: sess.notes,
      });
      setGrade(g);
      setAttempts((a) => [...a, { n: a.length + 1, percent: g.score.percent, timeUsedSec: sess.timeUsedSec }]);
      setScreen('results');
    } catch (e) {
      setError(e.message);
    }
  }

  const level = setup ? getLevel(setup.levelId) : null;

  return (
    <main className="container">
      <header className="brand" onClick={() => screen !== 'session' && setScreen('setup')}>
        <span className="logo">teach2learn</span>
        <span className="tagline">Learn it by teaching it.</span>
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

      {screen === 'results' && (
        <ResultsScreen
          plan={plan}
          level={level}
          session={session}
          grade={grade}
          attempts={attempts}
          timeLimitSec={setup.timeLimitSec}
          onRetry={() => setScreen('session')}
          onReview={() => setScreen('overview')}
          onNewTopic={() => setScreen('setup')}
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

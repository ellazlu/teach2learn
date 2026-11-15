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
// Teach to Learn
import ChecklistScreen from '../components/ChecklistScreen';
import StudyResults from '../components/StudyResults';
import StudyProgress, { StudyHistoryList } from '../components/StudyProgress';
import { MODE_NAME } from '../lib/learner/types.ts';
import { applyChecklist, toChecklist } from '../lib/learner/checklist.ts';
import { initLearner } from '../lib/learner/tracker.ts';
import { topicKeyOf } from '../lib/study/types.ts';
import {
  loadStudyProfile, saveStudyProfile, loadStudyHistory, saveStudyHistory, summarizeStudy, addStudySession,
  applyStudyPlan, historyForPlanner, recurringGaps, MAX_STUDY_RECORDS,
} from '../lib/study/progress.ts';

const MODE_KEY = 'teach2learn-mode';
const materialText = (sources = []) => sources.filter((x) => x.kind === 'text').map((x) => x.data).join('\n\n').slice(0, 20000);

function ModeTabs({ value, onChange }) {
  return (
    <div className="mode-tabs segmented compact" role="tablist">
      {['educator', 'student'].map((m) => (
        <button key={m} role="tab" aria-selected={value === m} className={value === m ? 'on' : ''} onClick={() => onChange(m)}>{MODE_NAME[m]}</button>
      ))}
    </div>
  );
}

// Screens: setup -> session -> feedback -> results
//          history -> history-detail, progress (any time you're not mid-session)
// After feedback is shown, the coach runs in the background and sets the next
// practice challenge; it never runs during a live session.
const BUSY = ['session', 'feedback', 'study-feedback'];

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
  // Teach to Learn state (separate from Learn to Teach)
  const [mode, setModeState] = useState('educator');
  const [viewMode, setViewMode] = useState('educator'); // which mode's progress/history is shown
  const [checklist, setChecklist] = useState(null); // { items, extraction, loading, error }
  const [studyHistory, setStudyHistory] = useState([]);
  const [studyProfile, setStudyProfile] = useState(null);
  const [studyPlans, setStudyPlans] = useState({}); // record id -> plan (this browser session)
  const studyHistoryRef = useRef([]);
  const studyProfileRef = useRef(null);
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
    studyHistoryRef.current = loadStudyHistory();
    setStudyHistory(studyHistoryRef.current);
    studyProfileRef.current = loadStudyProfile();
    setStudyProfile(studyProfileRef.current);
    try {
      const m = localStorage.getItem(MODE_KEY);
      if (m === 'student' || m === 'educator') {
        setModeState(m);
        setViewMode(m);
      }
    } catch {}
  }, []);

  function setMode(m) {
    setModeState(m);
    setViewMode(m);
    try { localStorage.setItem(MODE_KEY, m); } catch {}
  }

  function updateStudyHistory(fn) {
    const next = fn(studyHistoryRef.current).slice(0, MAX_STUDY_RECORDS);
    studyHistoryRef.current = next;
    setStudyHistory(next);
    setSaveFailed(!saveStudyHistory(next));
  }
  function updateStudyProfile(fn) {
    const next = fn(studyProfileRef.current);
    studyProfileRef.current = next;
    setStudyProfile(next);
    saveStudyProfile(next);
  }
  const patchStudy = (id, patch) => updateStudyHistory((h) => h.map((r) => (r.id === id ? { ...r, ...patch } : r)));

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
    if (s.mode === 'student') return buildChecklist({ ...s, topicId: `topic-${Date.now()}`, challenge: null, practice: null });
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
    setMode('educator');
    setSetup({
      mode: 'educator',
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

  // ---- Teach to Learn ------------------------------------------------------------------

  async function buildChecklist(s) {
    setSetup(s);
    setExtraction(null);
    setCurrentId(null);
    setChecklist({ items: null, extraction: null, loading: true, error: '' });
    setScreen('checklist');
    try {
      const ext = await postJSON('/api/prepare', { sources: s.sources, topic: s.topic, levelId: s.levelId, focus: s.focus, mode: 'student' });
      setChecklist({ items: toChecklist(ext), extraction: ext, loading: false, error: '' });
    } catch (e) {
      setChecklist({ items: null, extraction: null, loading: false, error: e.message });
    }
  }

  function startStudySession() {
    const ext = applyChecklist(checklist.extraction, checklist.items);
    setExtraction(ext);
    setCurrentId(null);
    setScreen('session');
  }

  // Practice: same checklist as the session it came from; the student opens with the question.
  function startPractice(pr) {
    const from = studyHistoryRef.current.find((r) => r.id === pr.fromSessionId);
    const prev = setupRef.current;
    const ext = from?.extraction;
    setError('');
    setMode('student');
    const s = {
      mode: 'student',
      topic: pr.topic,
      levelId: pr.levelId,
      timeLimitSec: from?.timeLimitSec || 300,
      sources: prev?.mode === 'student' && prev.topic === pr.topic ? prev.sources : [],
      focus: '',
      topicId: `topic-${Date.now()}`,
      challenge: null,
      practice: pr,
    };
    if (!ext) return buildChecklist(s);
    setSetup(s);
    setChecklist({ items: toChecklist(ext), extraction: ext, loading: false, error: '' });
    setScreen('checklist');
  }

  async function runPlannerFor(record) {
    patchStudy(record.id, { plan: { status: 'pending' } });
    const p = studyProfileRef.current;
    const input = { session: record, history: historyForPlanner(p, record.id), material: materialText(setupRef.current?.sources), note: p.note };
    try {
      const plan = await postJSON('/api/study-plan', input);
      updateStudyProfile((prof) => applyStudyPlan(prof, plan));
      setStudyPlans((m) => ({ ...m, [record.id]: plan }));
      patchStudy(record.id, { plan: { status: 'done', agent: plan.agent, ...(plan.error ? { error: plan.error } : {}) }, planResult: { analysis: plan.analysis, practiceId: plan.practice?.id || null, recurring: plan.recurring } });
    } catch (e) {
      patchStudy(record.id, { plan: { status: 'failed', error: e.message } });
    }
  }

  async function getStudyFeedback(sess) {
    const s = setupRef.current;
    setError('');
    setPending(sess);
    setScreen('study-feedback');
    try {
      const extractionUsed = sess.extraction;
      const learner = sess.learner || initLearner(extractionUsed);
      const topicTitle = extractionUsed?.topicTitle || s.topic || 'Your topic';
      const recurring = recurringGaps(studyProfileRef.current, topicKeyOf(topicTitle));
      const boards = sess.boards || [];
      const res = await postJSON('/api/study-feedback', {
        levelId: s.levelId,
        topicTitle,
        extraction: extractionUsed,
        learner,
        utterances: sess.utterances,
        boards: boards.map(({ thumb, ...b }) => b),
        material: materialText(s.sources),
        recurring,
      });
      const record = {
        version: 'study1',
        mode: 'student',
        id: `t-${Date.now()}`,
        createdAt: new Date().toISOString(),
        topicTitle,
        topicKey: topicKeyOf(topicTitle),
        levelId: s.levelId,
        timeLimitSec: s.timeLimitSec,
        timeUsedSec: sess.timeUsedSec,
        extraction: extractionUsed,
        learner,
        utterances: sess.utterances,
        boards,
        manualChecked: sess.manualChecked || [],
        feedback: res.feedback,
        evidence: res.evidence,
        practiceId: s.practice?.id || null,
        plan: { status: 'pending' },
      };
      updateStudyHistory((h) => [record, ...h]);
      updateStudyProfile((p) => addStudySession(p, summarizeStudy(record)));
      setCurrentId(record.id);
      setScreen('study-results');
      runPlannerFor(record); // background
    } catch (e) {
      setError(e.message);
    }
  }

  function deleteStudy(id) {
    updateStudyHistory((h) => h.filter((r) => r.id !== id));
    if (id === viewingId) setScreen('history');
  }

  // Repeat the same lesson as a plain session (no challenge scenario).
  function teachAgain() {
    setSetup((s) => ({ ...s, challenge: null }));
    setScreen('session');
  }

  function openPage(name) {
    if (!['history', 'history-detail', 'progress', 'study-detail'].includes(screen)) setReturnTo(screen);
    if (name === 'progress' || name === 'history') setViewMode(mode);
    setScreen(name);
  }
  const back = () => setScreen((returnTo === 'results' && !current) || (returnTo === 'study-results' && !currentStudy) ? 'setup' : returnTo);

  function deleteEntry(id) {
    updateHistory((h) => h.filter((e) => e.id !== id));
    if (id === currentId) setCurrentId(null);
    if (id === viewingId) setScreen('history');
  }

  const level = setup ? getLevel(setup.levelId) : null;
  const current = history.find((e) => e.id === currentId);
  const currentStudy = studyHistory.find((e) => e.id === currentId);
  const viewingStudy = studyHistory.find((e) => e.id === viewingId);
  const studyPracticeFor = (r) => {
    const id = studyPlans[r.id]?.practice?.id || r.planResult?.practiceId;
    return (studyProfile?.practice || []).find((p) => p.id === id) || studyPlans[r.id]?.practice || null;
  };
  const studyPlanFor = (r) => studyPlans[r.id] || (r.planResult ? { analysis: r.planResult.analysis, recurring: r.planResult.recurring } : null);
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
            {active && mode === 'educator' && screen !== 'results' && (
              <button className="btn-text" onClick={() => startChallenge(active)}>Next challenge</button>
            )}
            <button className="btn-text" onClick={() => openPage('progress')}>Progress</button>
            <button className="btn-text" onClick={() => openPage('history')}>
              History{(mode === 'student' ? studyHistory.length : history.length) > 0 && <span className="count">{mode === 'student' ? studyHistory.length : history.length}</span>}
            </button>
          </nav>
        )}
      </header>

      <main className="main">
        {screen === 'setup' && <SetupScreen key={mode} initial={setup && (setup.mode || 'educator') === mode ? setup : null} error={error} onSubmit={startNewTopic} mode={mode} onModeChange={setMode} />}

        {screen === 'checklist' && checklist && (
          <ChecklistScreen
            topic={setup?.topic}
            items={checklist.items}
            loading={checklist.loading}
            error={checklist.error}
            practice={setup?.practice}
            onChange={(items) => setChecklist((c) => ({ ...c, items }))}
            onRetry={() => buildChecklist(setup)}
            onStart={startStudySession}
            onBack={() => setScreen('setup')}
          />
        )}

        {screen === 'session' && (
          <SessionScreen
            setup={setup}
            level={level}
            extraction={extraction}
            onExtraction={setExtraction}
            onFinish={setup?.mode === 'student' ? getStudyFeedback : getFeedback}
            onExit={() => setScreen(setup?.mode === 'student' ? (currentStudy ? 'study-results' : 'checklist') : current ? 'results' : 'setup')}
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

        {screen === 'study-feedback' && (
          <div className="center-block">
            {error ? (
              <>
                <h2>Couldn't build feedback</h2>
                <p className="error">{error}</p>
                <div className="row">
                  <button className="btn primary" onClick={() => getStudyFeedback(pending)}>Retry</button>
                  <button className="btn" onClick={() => { setError(''); setScreen('session'); }}>Explain again</button>
                </div>
              </>
            ) : (
              <>
                <div className="spinner" aria-hidden />
                <p className="muted">Checking what you explained…</p>
              </>
            )}
          </div>
        )}

        {screen === 'study-results' && currentStudy && (
          <StudyResults
            record={currentStudy}
            plan={studyPlanFor(currentStudy)}
            practice={studyPracticeFor(currentStudy)}
            onPractice={startPractice}
            onRetryPlan={() => runPlannerFor(currentStudy)}
            footer={
              <div className="footer-actions">
                <button className="btn-text" onClick={() => openPage('progress')}>See progress</button>
                <button className="btn" onClick={() => setScreen('setup')}>New topic</button>
                <button className="btn" onClick={() => { setSetup((x) => ({ ...x, practice: null })); setChecklist({ items: toChecklist(currentStudy.extraction), extraction: currentStudy.extraction, loading: false, error: '' }); setScreen('checklist'); }}>Explain it again</button>
              </div>
            }
          />
        )}

        {screen === 'study-detail' && viewingStudy && (
          <StudyResults
            record={viewingStudy}
            plan={studyPlanFor(viewingStudy)}
            practice={studyPracticeFor(viewingStudy)}
            onPractice={startPractice}
            onRetryPlan={() => runPlannerFor(viewingStudy)}
            isHistory
            footer={
              <div className="footer-actions">
                <button className="btn" onClick={() => setScreen('history')}>Back to history</button>
                <button className="btn-text" onClick={() => window.confirm('Delete this session?') && deleteStudy(viewingStudy.id)}>Delete</button>
              </div>
            }
          />
        )}

        {(screen === 'progress' || screen === 'history') && <ModeTabs value={viewMode} onChange={setViewMode} />}

        {screen === 'progress' && viewMode === 'student' && studyProfile && (
          <div className="progress">
            <div className="page-head">
              <button className="btn-text" onClick={back}>← Back</button>
              <h1>Progress</h1>
              <span />
            </div>
            <StudyProgress profile={studyProfile} onPractice={startPractice} onOpenSession={(id) => { if (studyHistory.some((h) => h.id === id)) { setViewingId(id); setScreen('study-detail'); } }} />
          </div>
        )}

        {screen === 'history' && viewMode === 'student' && (
          <div className="history">
            <div className="page-head">
              <button className="btn-text" onClick={back}>← Back</button>
              <h1>History</h1>
              <span />
            </div>
            <StudyHistoryList records={studyHistory} onOpen={(id) => { setViewingId(id); setScreen('study-detail'); }} onDelete={deleteStudy} />
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

        {screen === 'progress' && viewMode === 'educator' && profile && (
          <ProgressScreen
            profile={profile}
            onStartChallenge={startChallenge}
            onOpenSession={(id) => { if (history.some((h) => h.id === id)) { setViewingId(id); setScreen('history-detail'); } }}
            onBack={back}
          />
        )}

        {screen === 'history' && viewMode === 'educator' && (
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

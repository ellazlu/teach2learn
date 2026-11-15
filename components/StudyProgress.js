'use client';

import { getLevel } from '../lib/levels.ts';
import { UNDERSTANDING_LABEL } from '../lib/learner/types.ts';
import { currentPractice, topicsView } from '../lib/study/progress.ts';

const CLS = { demonstrated: 'ok', partial: 'mid', not_verified: 'neutral' };
const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// Teach to Learn progress: topics studied, what's still a gap, and practice to retry.
export default function StudyProgress({ profile, onPractice, onOpenSession }) {
  const topics = topicsView(profile);
  const current = currentPractice(profile);
  const open = profile.practice.filter((p) => p.status === 'open' && p.id !== current?.id).slice(-3).reverse();

  if (!profile.sessions.length) {
    return <p className="muted">Finish a Teach to Learn session to see the topics you've studied and what's left to review.</p>;
  }

  return (
    <div className="study-progress">
      {current && (
        <section className="panel">
          <h2 className="label">Practice next</h2>
          <h3>{current.conceptName} <span className="muted small">· {current.topic}</span></h3>
          <p>The student will open with: <q>{current.prompt}</q></p>
          {current.attempts.length > 0 && <p className="small muted">Tried {current.attempts.length}×: {current.attempts.map((a) => UNDERSTANDING_LABEL[a.understanding].toLowerCase()).join(', ')}.</p>}
          <button className="btn primary large" onClick={() => onPractice(current)}>{current.attempts.length ? 'Try again' : 'Retry this explanation'}</button>
        </section>
      )}

      {topics.map((t) => (
        <section className="panel" key={t.topicKey}>
          <div className="panel-head">
            <h2 className="topic-title">{t.topic}</h2>
            <span className="muted small">{t.sessions} session{t.sessions === 1 ? '' : 's'} · last {shortDate(t.lastAt)}</span>
          </div>
          <ul className="concept-summary">
            {t.concepts.map((c) => (
              <li key={c.name}>
                <div className="cs-row">
                  <span className="concept-name">{c.name}</span>
                  <span className={`status ${CLS[c.latest]}`}>{UNDERSTANDING_LABEL[c.latest]}</span>
                </div>
                {c.history.length > 1 && <p className="cs-note">Earlier: {c.history.slice(0, -1).map((h) => UNDERSTANDING_LABEL[h].replace(' understanding', '').toLowerCase()).join(' → ')}</p>}
              </li>
            ))}
          </ul>
          <p className="small">
            {t.remaining.length ? <><span className="muted">Still to show:</span> {t.remaining.join(', ')}</> : 'Every concept on this checklist was demonstrated in the latest session.'}
          </p>
          <button className="btn-text small" onClick={() => onOpenSession(t.lastSessionId)}>Open latest session</button>
        </section>
      ))}

      {open.length > 0 && (
        <section className="panel">
          <h2 className="label">Other open practice</h2>
          <ul className="plain-rows">
            {open.map((p) => (
              <li key={p.id}>
                <span>{p.conceptName} <span className="muted">· {p.topic}</span></span>
                <button className="btn-text" onClick={() => onPractice(p)}>Retry</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="fine">Each status comes from one session's conversation. It shows what you explained that day, not lasting mastery.</p>
    </div>
  );
}

export function StudyHistoryList({ records, onOpen, onDelete }) {
  if (!records.length) return <p className="muted">No Teach to Learn sessions yet.</p>;
  return (
    <ul className="history-list">
      {records.map((r) => {
        const shown = r.feedback.concepts.filter((c) => c.understanding === 'demonstrated').length;
        return (
          <li key={r.id}>
            <button className="history-open" onClick={() => onOpen(r.id)}>
              <span className="h-title">{r.topicTitle}</span>
              <span className="h-meta">{getLevel(r.levelId).label} · {shown} of {r.feedback.concepts.length} concepts demonstrated{r.practiceId ? ' · practice' : ''}</span>
              <span className="h-date">{new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
            </button>
            <button className="btn-text small" aria-label="Delete session" onClick={() => window.confirm('Delete this session?') && onDelete(r.id)}>Delete</button>
          </li>
        );
      })}
    </ul>
  );
}

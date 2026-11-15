'use client';

import { useState } from 'react';
import { getLevel } from '../lib/levels.ts';
import { formatTime } from '../lib/client';
import { fmt } from '../lib/student/speech.ts';
import { UNDERSTANDING_LABEL, MODE_NAME } from '../lib/learner/types.ts';
import { Turn } from './SessionScreen';

const CLS = { demonstrated: 'ok', partial: 'mid', not_verified: 'neutral' };

// "Review X: why" -> "Why", so the concept name isn't repeated.
function reviewText({ name, text }) {
  let t = String(text || '').trim();
  const lower = t.toLowerCase();
  for (const prefix of [`review ${name.toLowerCase()}:`, `${name.toLowerCase()}:`]) if (lower.startsWith(prefix)) t = t.slice(prefix.length).trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Teach to Learn results: content only. No delivery metrics, no scores.
export default function StudyResults({ record, plan, practice, onPractice, onRetryPlan, footer, isHistory }) {
  const level = getLevel(record.levelId);
  const fb = record.feedback;
  const boards = (record.boards || []).filter((b) => !b.blank);
  const review = plan?.analysis?.priority ? { name: plan.analysis.priority.name, text: plan.analysis.priority.why } : fb.reviewNext;
  const status = record.plan?.status;
  const [showLookFor, setShowLookFor] = useState(false);

  return (
    <div className="results study-results">
      <header className="results-head">
        <p className="eyebrow">
          {MODE_NAME.student} · explained to a {level.label.toLowerCase()} · {formatTime(record.timeUsedSec)}
          {isHistory && ` · ${new Date(record.createdAt).toLocaleString()}`}
        </p>
        <h1>{record.topicTitle}</h1>
      </header>

      <div className="results-grid">
        <section>
          <dl className="three study-feedback">
            <div className="three-item">
              <dt>Correct understanding</dt>
              <dd>{fb.correct.text}</dd>
            </div>
            <div className="three-item">
              <dt>Knowledge gaps</dt>
              <dd>{fb.gaps.text}</dd>
            </div>
            <div className="three-item">
              <dt>Misconceptions</dt>
              <dd>
                {fb.misconceptions.length === 0 ? (
                  'None found in what you said.'
                ) : (
                  <ul className="mis-feedback">
                    {fb.misconceptions.map((m) => (
                      <li key={m.evidenceId}>
                        <q>{m.quote}</q>
                        {m.at !== null && <span className="ts"> {fmt(m.at)}</span>}
                        {m.source === 'whiteboard' && <span className="tag">whiteboard</span>}
                        <span className="mis-note">{m.note}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
            <div className="three-item">
              <dt>What to review next</dt>
              <dd>{review ? <><strong>{review.name}.</strong> {reviewText(review)}</> : 'Nothing urgent: everything on the checklist was demonstrated.'}</dd>
            </div>
          </dl>
        </section>

        <section className="challenge-card">
          <h2 className="label">Practice next</h2>
          {(!status || status === 'pending') && <p className="muted coach-pending"><span className="spinner small" aria-hidden /> Analyzing your knowledge gaps…</p>}
          {status === 'failed' && (
            <div>
              <p className="muted">The analysis didn't finish{record.plan.error ? ` (${record.plan.error})` : ''}.</p>
              <button className="btn" onClick={onRetryPlan}>Try again</button>
            </div>
          )}
          {status === 'done' && !practice && <p className="muted">Not enough was explained to plan practice. Try a longer session.</p>}
          {status === 'done' && practice && (
            <div className="next">
              <h3>{practice.conceptName}</h3>
              <p>The student will open with: <q>{practice.prompt}</q></p>
              {plan?.recurring?.length > 0 && <p className="small muted">Also a gap in an earlier session: {plan.recurring.join(', ')}.</p>}
              <button className="btn primary large" onClick={() => onPractice(practice)}>Retry this explanation</button>
              <button className="btn-text small" onClick={() => setShowLookFor((s) => !s)}>{showLookFor ? 'Hide' : 'Show'} what a full answer covers</button>
              {showLookFor && (
                <ul className="criteria">
                  {practice.lookFor.map((x, i) => <li key={i}><span className="crit na">○</span>{x}</li>)}
                </ul>
              )}
            </div>
          )}
        </section>
      </div>

      <section>
        <h2 className="label">Concepts</h2>
        <ul className="concept-summary">
          {fb.concepts.map((c) => (
            <li key={c.id}>
              <div className="cs-row">
                <span className="concept-name">
                  {c.name}
                  {record.manualChecked?.includes(c.id) && <span className="tag" title="You ticked this yourself">ticked</span>}
                </span>
                <span className={`status ${CLS[c.understanding]}`}>{UNDERSTANDING_LABEL[c.understanding]}</span>
              </div>
              <p className="cs-note">{c.note}</p>
            </li>
          ))}
        </ul>
        <p className="fine">Based on this session only. A concept counts as demonstrated when you explained it accurately and handled a follow-up question on it.</p>
      </section>

      {boards.length > 0 && (
        <details className="evidence-details">
          <summary>Whiteboard ({boards.length})</summary>
          <ul className="board-list">
            {boards.map((b) => (
              <li key={b.id}>
                {b.thumb && <img src={b.thumb} alt="Whiteboard snapshot" className="board-thumb" />}
                <div>
                  <span className="ts">{fmt(b.at)}</span>
                  {b.transcription && <p><span className="muted">Written:</span> {b.transcription}</p>}
                  {b.description && <p><span className="muted">Drawn:</span> {b.description}</p>}
                  {b.unclear.length > 0 && <p className="muted small">Couldn't read: {b.unclear.map((u) => u.part).join('; ')}</p>}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}

      <details className="transcript-details">
        <summary>Transcript</summary>
        <div className="convo static">
          {record.utterances.length ? record.utterances.map((u) => <Turn key={u.id} u={u} />) : <p className="muted">Nothing was captured.</p>}
        </div>
      </details>

      {footer}
    </div>
  );
}

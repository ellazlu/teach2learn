'use client';

import { formatTime } from '../lib/client';
import { getLevel } from '../lib/levels';
import { Note } from './SessionScreen';
import { TopicOverview } from './OverviewScreen';

const STATUS = {
  met: { label: 'Met', icon: '✅' },
  partial: { label: 'Partial', icon: '🟡' },
  missing: { label: 'Missing', icon: '❌' },
};

// Shows one graded session. Used right after a session and when reopening a
// session from History. `attempts` = all sessions on the same topic, oldest first.
// `footer` = the buttons for this context.
export default function ResultsScreen({ entry, attempts, isHistory, footer }) {
  const { plan, session, grade, timeLimitSec } = entry;
  const level = getLevel(entry.levelId);
  const { score } = grade;
  const conceptName = (id) => plan.concepts.find((c) => c.id === id)?.name || id;
  const idx = attempts.findIndex((a) => a.id === entry.id);
  const prev = idx > 0 ? attempts[idx - 1] : null;
  const prevPercent = prev?.grade.score.percent;

  return (
    <div className="stack">
      <section className="card score-card">
        <div>
          <p className="eyebrow">
            {plan.topic_title} · {level.emoji} {level.label}
            {isHistory && ` · ${new Date(entry.createdAt).toLocaleString()}`}
          </p>
          <div className="score">{score.percent}%</div>
          <p className="muted">
            ✅ {score.met} met · 🟡 {score.partial} partial · ❌ {score.missing} missing ·
            ⏱ {formatTime(session.timeUsedSec)} of {formatTime(timeLimitSec)}
          </p>
          {prev && (
            <p className={score.percent >= prevPercent ? 'good' : 'muted'}>
              {score.percent > prevPercent
                ? `▲ Up ${score.percent - prevPercent} points from the previous attempt`
                : score.percent === prevPercent
                ? 'Same score as the previous attempt'
                : `▼ Down ${prevPercent - score.percent} points from the previous attempt`}
            </p>
          )}
        </div>
        {grade.summary && <p className="summary">{grade.summary}</p>}
      </section>

      <section className="card">
        <h2>Graded rubric</h2>
        <ul className="rubric-results">
          {grade.results.map((r) => (
            <li key={r.id} className={`result ${r.status}`}>
              <div className="result-head">
                <span className="pill">{STATUS[r.status].icon} {STATUS[r.status].label}</span>
                <span className="criterion">{r.criterion}</span>
              </div>
              {r.reason && <p className="reason">{r.reason}</p>}
              {r.evidence_quote && <blockquote>You said: “{r.evidence_quote}”</blockquote>}
              {r.status !== 'met' && r.source_quote && (
                <blockquote className="source">From your material ({r.source_name}): “{r.source_quote}”</blockquote>
              )}
            </li>
          ))}
        </ul>
      </section>

      {grade.misconceptions.length > 0 && (
        <section className="card">
          <h2>⚠️ Things that contradict your material</h2>
          <ul className="feedback-list">
            {grade.misconceptions.map((m, i) => (
              <li key={i}>
                <blockquote>You said: “{m.user_quote}”</blockquote>
                <p>{m.issue}</p>
                {m.source_quote && <blockquote className="source">Your material says: “{m.source_quote}”</blockquote>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {grade.outside_knowledge.length > 0 && (
        <section className="card">
          <h2>🌱 Beyond your material</h2>
          <p className="muted">Ideas you brought in that aren't in your files. These don't change your score.</p>
          <ul className="feedback-list">
            {grade.outside_knowledge.map((o, i) => (
              <li key={i} className={o.correct ? 'good-item' : 'bad-item'}>
                <strong>{o.correct ? '👏' : '✋'} {o.term_or_idea}</strong>
                <span className="muted"> · relates to {conceptName(o.related_concept_id)}</span>
                <p>{o.comment}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {grade.lost_moments.length > 0 && (
        <section className="card">
          <h2>😕 Where your learner got lost</h2>
          <ul className="feedback-list">
            {grade.lost_moments.map((l, i) => (
              <li key={i}>
                <strong>“{l.phrase}”</strong>
                <p>{l.tip}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {grade.suggestions.length > 0 && (
        <section className="card">
          <h2>What to work on</h2>
          <ol className="suggestions">
            {grade.suggestions.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        </section>
      )}

      <section className="card">
        <details>
          <summary>📘 Topic overview</summary>
          <div className="details-body">
            <TopicOverview plan={plan} />
          </div>
        </details>
        <details>
          <summary>📓 Learner's notebook ({session.notes.length} notes)</summary>
          <ul className="notebook static">
            {session.notes.map((n, i) => <Note key={i} note={n} />)}
          </ul>
        </details>
        <details>
          <summary>🗣️ Your full transcript</summary>
          <p className="transcript static">{session.transcript || '(nothing captured)'}</p>
        </details>
      </section>

      {attempts.length > 1 && (
        <section className="card">
          <h3>All attempts on this topic</h3>
          <ul className="attempts">
            {attempts.map((a, i) => (
              <li key={a.id} className={a.id === entry.id ? 'current' : ''}>
                Attempt {i + 1}: <strong>{a.grade.score.percent}%</strong> in {formatTime(a.session.timeUsedSec)}
                {a.id === entry.id && <span className="muted"> (this one)</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {footer}
    </div>
  );
}

'use client';

import { formatTime } from '../lib/client';
import { Note } from './SessionScreen';

const STATUS = {
  met: { label: 'Met', icon: '✅' },
  partial: { label: 'Partial', icon: '🟡' },
  missing: { label: 'Missing', icon: '❌' },
};

export default function ResultsScreen({ plan, level, session, grade, attempts, timeLimitSec, onRetry, onReview, onNewTopic }) {
  const { score } = grade;
  const conceptName = (id) => plan.concepts.find((c) => c.id === id)?.name || id;
  const previous = attempts.slice(0, -1);
  const prev = previous[previous.length - 1];

  return (
    <div className="stack">
      <section className="card score-card">
        <div>
          <p className="eyebrow">{plan.topic_title} · {level.emoji} {level.label}</p>
          <div className="score">{score.percent}%</div>
          <p className="muted">
            ✅ {score.met} met · 🟡 {score.partial} partial · ❌ {score.missing} missing ·
            ⏱ {formatTime(session.timeUsedSec)} of {formatTime(timeLimitSec)}
          </p>
          {prev && (
            <p className={score.percent >= prev.percent ? 'good' : 'muted'}>
              {score.percent > prev.percent
                ? `▲ Up ${score.percent - prev.percent} points from your last attempt`
                : score.percent === prev.percent
                ? 'Same score as your last attempt'
                : `▼ Down ${prev.percent - score.percent} points from your last attempt`}
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

      {previous.length > 0 && (
        <section className="card">
          <h3>Your attempts</h3>
          <ul className="attempts">
            {attempts.map((a) => (
              <li key={a.n}>Attempt {a.n}: <strong>{a.percent}%</strong> in {formatTime(a.timeUsedSec)}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="row space-between">
        <div className="row">
          <button className="btn ghost" onClick={onNewTopic}>New topic</button>
          <button className="btn ghost" onClick={onReview}>Review rubric</button>
        </div>
        <button className="btn big" onClick={onRetry}>↻ Try again</button>
      </div>
    </div>
  );
}

'use client';

import { formatTime } from '../lib/client';

export default function OverviewScreen({ plan, level, timeLimitSec, onBack, onStart }) {
  return (
    <div className="stack">
      <section className="card">
        <p className="eyebrow">Your topic</p>
        <h2>{plan.topic_title}</h2>
        <p>{plan.overview}</p>
        <h3>What your material covers</h3>
        <ul className="concepts">
          {plan.concepts.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong>: {c.summary}
              {c.key_terms?.length > 0 && (
                <div className="terms">
                  {c.key_terms.map((t) => <span key={t} className="term">{t}</span>)}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <p className="eyebrow">The rubric · {level.emoji} {level.label}</p>
        <h2>Your learner's notes will be graded on these</h2>
        <ol className="rubric-preview">
          {plan.rubric.map((r) => (
            <li key={r.id}>
              {r.criterion}
              {r.key_terms?.length > 0 && (
                <div className="terms">
                  {r.key_terms.map((t) => <span key={t} className="term">{t}</span>)}
                </div>
              )}
            </li>
          ))}
        </ol>
      </section>

      <div className="row space-between">
        <button className="btn ghost" onClick={onBack}>← Change setup</button>
        <button className="btn big" onClick={onStart}>Start teaching ({formatTime(timeLimitSec)}) →</button>
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';

// What the simulated student understands right now, by evidence level.
// Being explained is not the same as being understood.
export function conceptState(c) {
  if (c.verification === 'demonstrated') return { label: 'Demonstrated', cls: 'ok' };
  if (c.verification === 'partial') return { label: 'Partially understood', cls: 'mid' };
  if ((c.openGaps || []).length) return { label: 'Has a question', cls: 'mid' };
  if (c.explained) return { label: 'Explained, not verified', cls: 'neutral' };
  if (c.mentioned) return { label: 'Mentioned', cls: 'neutral' };
  return { label: 'Not covered', cls: 'faint' };
}

const MIS = { active: 'Believes', partially_addressed: 'Unsure', resolved: 'Corrected' };

export default function StudentPanel({ model, loading, error, onRetry }) {
  const [revealed, setRevealed] = useState([]);

  if (!model) {
    return (
      <div className="panel">
        <h3 className="label">Student understanding</h3>
        <p className="muted small">
          {error ? (
            <>
              Couldn't prepare the student ({error}).{' '}
              <button className="btn-text" onClick={onRetry}>Retry</button>
            </>
          ) : loading ? (
            'Reading your topic. You can start talking now.'
          ) : null}
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3 className="label">Student understanding</h3>
      <ul className="concept-list">
        {model.concepts.map((c) => {
          const s = conceptState(c);
          return (
            <li key={c.id} title={c.description}>
              <span className="concept-name">{c.name}</span>
              <span className={`status ${s.cls}`}>{s.label}</span>
            </li>
          );
        })}
      </ul>
      {model.misconceptions.length > 0 && (
        <ul className="mis-list">
          {model.misconceptions.map((m) => (
            <li key={m.id}>
              <span className={`status ${m.status === 'resolved' ? 'ok' : m.status === 'active' ? 'bad' : 'mid'}`}>{MIS[m.status]}</span>
              {m.expressed || m.status !== 'active' || revealed.includes(m.id) ? (
                <span className={m.status === 'resolved' ? 'struck' : ''}>{m.belief}</span>
              ) : (
                <button className="btn-text small" onClick={() => setRevealed([...revealed, m.id])}>
                  Hidden misconception (reveal)
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="fine">Simulated student. A concept only counts as understood once the student shows it.</p>
    </div>
  );
}

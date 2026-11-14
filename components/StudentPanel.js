'use client';

import { useState } from 'react';
import { behaviorLabel } from './Avatar';

const STATUS = {
  active: { label: 'believes it', cls: 'bad' },
  partially_addressed: { label: 'unsure now', cls: 'mid' },
  resolved: { label: 'resolved', cls: 'good' },
};

// Compact, collapsible view of the simulated student's state during a session.
export default function StudentPanel({ model, initialModel, loading, error, onRetry }) {
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState([]);

  if (!model) {
    return (
      <div className="student-panel collapsed">
        <span className="muted small">
          {error ? (
            <>
              Couldn't build the student's knowledge model ({error}).{' '}
              <button className="link small" onClick={onRetry}>Try again</button>
            </>
          ) : loading ? (
            'Your student is skimming the material… (start teaching, nothing is lost)'
          ) : null}
        </span>
      </div>
    );
  }

  const active = model.misconceptions.filter((m) => m.status !== 'resolved').length;
  const avg = Math.round(model.concepts.reduce((n, c) => n + c.mastery, 0) / Math.max(1, model.concepts.length));
  const avg0 = Math.round(initialModel.concepts.reduce((n, c) => n + c.mastery, 0) / Math.max(1, initialModel.concepts.length));

  return (
    <div className={`student-panel ${open ? 'open' : 'collapsed'}`}>
      <button className="panel-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>🧠 Student understanding</span>
        <span className="muted small">
          {behaviorLabel(model.behavior)} · avg {avg}% ({avg - avg0 >= 0 ? '+' : ''}{avg - avg0}) · {active} misconception{active === 1 ? '' : 's'} left
        </span>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="panel-body">
          <p className="muted tiny">Simulated estimates of what the virtual student understands, not a measurement of real learning.</p>
          <ul className="concept-bars">
            {model.concepts.map((c) => (
              <ConceptBar key={c.id} concept={c} />
            ))}
          </ul>
          {model.misconceptions.length > 0 && (
            <>
              <p className="panel-sub">Misconceptions</p>
              <ul className="mis-list">
                {model.misconceptions.map((m) => (
                  <li key={m.id}>
                    <span className={`tag ${STATUS[m.status].cls}`}>{STATUS[m.status].label}</span>
                    {m.expressed || m.status !== 'active' || revealed.includes(m.id) ? (
                      <span className={m.status === 'resolved' ? 'struck' : ''}>{m.belief}</span>
                    ) : (
                      <button className="link small" onClick={() => setRevealed([...revealed, m.id])} title="The student hasn't said this yet. Peek if you want a hint.">
                        🔒 not voiced yet (peek)
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ConceptBar({ concept: c, from }) {
  const start = from ?? c.initialMastery;
  const delta = c.mastery - start;
  const icon = c.explained ? '✓' : c.mentioned ? '👂' : '·';
  const title = c.explained ? 'explained' : c.mentioned ? 'mentioned, not explained yet' : 'not covered yet';
  return (
    <li className="concept-bar" title={c.description}>
      <span className="cb-name">
        <span className="cb-icon" title={title}>{icon}</span> {c.name}
      </span>
      <span className="cb-track">
        <span className="cb-start" style={{ width: `${Math.min(start, c.mastery)}%` }} />
        {delta > 0 && <span className="cb-gain" style={{ left: `${start}%`, width: `${delta}%` }} />}
        {delta < 0 && <span className="cb-loss" style={{ left: `${c.mastery}%`, width: `${-delta}%` }} />}
      </span>
      <span className={`cb-num ${delta > 0 ? 'good' : delta < 0 ? 'bad' : ''}`}>
        {c.mastery}
        {delta !== 0 && <small> ({delta > 0 ? '+' : ''}{delta})</small>}
      </span>
    </li>
  );
}

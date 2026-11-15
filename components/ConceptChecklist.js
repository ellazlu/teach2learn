'use client';

import { COVERAGE_LABEL } from '../lib/learner/types.ts';

const CLS = { not_covered: 'faint', discussed: 'neutral', demonstrated: 'ok' };

// Teach to Learn, live: what to cover, and what the conversation shows so far.
// The user's own checkmarks are separate from the tracked status.
export default function ConceptChecklist({ learner, manual, onToggle }) {
  if (!learner) return null;
  const done = learner.concepts.filter((c) => c.coverage === 'demonstrated').length;
  const touched = learner.concepts.filter((c) => c.coverage !== 'not_covered').length;
  return (
    <details className="panel checklist-live" open>
      <summary>
        <span className="label">Checklist</span>
        <span className="muted small">{touched}/{learner.concepts.length} discussed · {done} demonstrated</span>
      </summary>
      <ul className="concept-list">
        {learner.concepts.map((c) => (
          <li key={c.id} className={`cl-${c.coverage}`}>
            <label className="cl-mark" title="Your own checkmark (doesn't affect the status)">
              <input type="checkbox" checked={manual.includes(c.id)} onChange={() => onToggle(c.id)} />
              <span className="concept-name">{c.name}</span>
            </label>
            <span className={`status ${CLS[c.coverage]}`}>{COVERAGE_LABEL[c.coverage]}</span>
          </li>
        ))}
      </ul>
      <p className="fine">Your ticks are just for you. "Demonstrated" needs an accurate explanation and a follow-up question answered well.</p>
    </details>
  );
}

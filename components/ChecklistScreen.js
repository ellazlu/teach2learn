'use client';

import { useState } from 'react';
import { addItem, checklistProblems, moveItem, removeItem, renameItem, TARGET, MAX_ITEMS } from '../lib/learner/checklist.ts';

// Teach to Learn: review the concept checklist before starting. Names only;
// what each concept should contain stays hidden (it's what you're testing).
export default function ChecklistScreen({ topic, items, loading, error, onChange, onRetry, onStart, onBack, practice }) {
  const [draft, setDraft] = useState('');
  const problems = items ? checklistProblems(items) : [];

  return (
    <div className="checklist-setup">
      <div className="page-head">
        <button className="btn-text" onClick={onBack}>← Back</button>
        <h1>Your checklist</h1>
        <span />
      </div>

      {loading && (
        <div className="center-block">
          <div className="spinner" aria-hidden />
          <p className="muted">Finding the key concepts{topic ? ` in ${topic}` : ''}…</p>
        </div>
      )}

      {error && !loading && (
        <div className="center-block">
          <p className="error">{error}</p>
          <button className="btn" onClick={onRetry}>Try again</button>
        </div>
      )}

      {items && !loading && (
        <>
          <p className="muted">
            The key ideas to explain, in a sensible order. Rename, add, remove or reorder them. Only the names are shown, never the answers.
            {items.length < TARGET.min && ' A few more concepts usually makes a better session.'}
          </p>
          {practice && (
            <p className="challenge-goal"><span className="label">Practice</span> The student will start by asking about {practice.conceptName.toLowerCase()}.</p>
          )}
          <ol className="checklist-edit">
            {items.map((it, i) => (
              <li key={it.id}>
                <span className="ce-num">{i + 1}</span>
                <input className="input" value={it.name} aria-label={`Concept ${i + 1}`} onChange={(e) => onChange(renameItem(items, it.id, e.target.value))} />
                <span className="ce-actions">
                  <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => onChange(moveItem(items, it.id, -1))}>↑</button>
                  <button type="button" className="icon-btn" aria-label="Move down" disabled={i === items.length - 1} onClick={() => onChange(moveItem(items, it.id, 1))}>↓</button>
                  <button type="button" className="icon-btn" aria-label="Remove" onClick={() => onChange(removeItem(items, it.id))}>×</button>
                </span>
              </li>
            ))}
          </ol>
          <form
            className="ce-add"
            onSubmit={(e) => {
              e.preventDefault();
              onChange(addItem(items, draft));
              setDraft('');
            }}
          >
            <input className="input" placeholder="Add a concept" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={items.length >= MAX_ITEMS} />
            <button className="btn" type="submit" disabled={!draft.trim() || items.length >= MAX_ITEMS}>Add</button>
          </form>
          {problems.length > 0 && <p className="error small">{problems[0]}</p>}
          <div className="setup-actions">
            <button className="btn primary large" onClick={onStart} disabled={problems.length > 0}>Start session</button>
            <span className="muted small">The checklist stays beside the conversation. You can tick items off yourself; the status next to each one comes from what you actually explain.</span>
          </div>
        </>
      )}
    </div>
  );
}

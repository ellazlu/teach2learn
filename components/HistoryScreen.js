'use client';

import { formatTime } from '../lib/client';
import { getLevel } from '../lib/levels.ts';
import { attemptNumber } from '../lib/history.ts';

function stats(e) {
  if (e.version !== 3) return 'older session';
  const learned = e.learning.learned.length;
  const resolved = e.finalModel?.misconceptions.filter((m) => m.status === 'resolved').length || 0;
  const total = e.finalModel?.misconceptions.length || 0;
  return `learned ${learned} concept${learned === 1 ? '' : 's'} · ${resolved}/${total} misconceptions fixed`;
}

export default function HistoryScreen({ history, saveFailed, onOpen, onDelete, onClearAll, onBack }) {
  return (
    <div className="stack">
      <div className="row space-between">
        <button className="btn ghost" onClick={onBack}>← Back</button>
        {history.length > 0 && (
          <button className="link" onClick={() => window.confirm('Delete all saved sessions?') && onClearAll()}>Clear all</button>
        )}
      </div>

      <section className="card">
        <h2>🕘 Past sessions</h2>
        <p className="muted">Saved in this browser. Open one to see your student's progress, the feedback, and the full conversation.</p>
        {saveFailed && <p className="warning">Browser storage is full, so your oldest sessions weren't saved.</p>}

        {history.length === 0 ? (
          <p className="muted empty">No sessions yet. Finish a teaching session and it'll show up here.</p>
        ) : (
          <ul className="history-list">
            {history.map((e) => {
              const level = getLevel(e.levelId);
              return (
                <li key={e.id} className="history-item">
                  <button className="history-open" onClick={() => onOpen(e.id)}>
                    <span className="history-emoji">{level.emoji}</span>
                    <span className="history-text">
                      <strong>{e.topicTitle}</strong>
                      <span className="muted small">
                        {level.label} · attempt {attemptNumber(history, e)} · {formatTime(e.timeUsedSec)} · {stats(e)} ·{' '}
                        {new Date(e.createdAt).toLocaleString()}
                      </span>
                    </span>
                  </button>
                  <button className="link" aria-label="Delete session" onClick={() => window.confirm('Delete this session?') && onDelete(e.id)}>
                    delete
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

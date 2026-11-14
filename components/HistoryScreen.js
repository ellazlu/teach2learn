'use client';

import { formatTime } from '../lib/client';
import { getLevel } from '../lib/levels.ts';
import { attemptNumber } from '../lib/history.ts';

function summary(e) {
  if (e.version !== 4) return 'Earlier format';
  const shown = e.concepts.filter((c) => c.status === 'Demonstrated understanding').length;
  return `${shown} of ${e.concepts.length} concept${e.concepts.length === 1 ? '' : 's'} demonstrated`;
}

export default function HistoryScreen({ history, saveFailed, onOpen, onDelete, onClearAll, onBack }) {
  return (
    <div className="history">
      <div className="page-head">
        <button className="btn-text" onClick={onBack}>← Back</button>
        <h1>History</h1>
        {history.length > 0 ? (
          <button className="btn-text" onClick={() => window.confirm('Delete all saved sessions?') && onClearAll()}>Clear all</button>
        ) : (
          <span />
        )}
      </div>
      {saveFailed && <p className="notice">Browser storage is full, so the oldest sessions weren't saved.</p>}
      {history.length === 0 ? (
        <p className="muted">No sessions yet. Finished sessions are saved in this browser.</p>
      ) : (
        <ul className="history-list">
          {history.map((e) => {
            const level = getLevel(e.levelId);
            return (
              <li key={e.id}>
                <button className="history-open" onClick={() => onOpen(e.id)}>
                  <span className="h-title">{e.topicTitle}</span>
                  <span className="h-meta">
                    {level.label} · attempt {attemptNumber(history, e)} · {formatTime(e.timeUsedSec)} · {summary(e)}
                  </span>
                  <span className="h-date">{new Date(e.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                </button>
                <button className="btn-text small" aria-label="Delete session" onClick={() => window.confirm('Delete this session?') && onDelete(e.id)}>
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

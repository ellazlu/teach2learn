'use client';

import { formatTime } from '../lib/client';
import { getLevel } from '../lib/levels';
import { attemptsFor } from '../lib/history';

export default function HistoryScreen({ history, saveFailed, onOpen, onDelete, onClearAll, onBack }) {
  return (
    <div className="stack">
      <div className="row space-between">
        <button className="btn ghost" onClick={onBack}>← Back</button>
        {history.length > 0 && (
          <button
            className="link"
            onClick={() => window.confirm('Delete all saved sessions?') && onClearAll()}
          >
            Clear all
          </button>
        )}
      </div>

      <section className="card">
        <h2>🕘 Past sessions</h2>
        <p className="muted">
          Saved in this browser. Open one to see its overview, graded rubric, feedback, notes, and transcript.
        </p>
        {saveFailed && (
          <p className="warning">Browser storage is full, so your oldest sessions weren't saved.</p>
        )}

        {history.length === 0 ? (
          <p className="muted empty">No sessions yet. Finish a teaching session and it'll show up here.</p>
        ) : (
          <ul className="history-list">
            {history.map((e) => {
              const level = getLevel(e.levelId);
              const attempts = attemptsFor(history, e);
              const n = attempts.findIndex((a) => a.id === e.id) + 1;
              const pct = e.grade.score.percent;
              return (
                <li key={e.id} className="history-item">
                  <button className="history-open" onClick={() => onOpen(e.id)}>
                    <span className={`score-badge ${pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : 'lo'}`}>{pct}%</span>
                    <span className="history-text">
                      <strong>{e.plan.topic_title}</strong>
                      <span className="muted small">
                        {level.emoji} {level.label} · attempt {n} · {formatTime(e.session.timeUsedSec)} of{' '}
                        {formatTime(e.timeLimitSec)} · {new Date(e.createdAt).toLocaleString()}
                      </span>
                    </span>
                  </button>
                  <button
                    className="link"
                    aria-label="Delete session"
                    onClick={() => window.confirm('Delete this session?') && onDelete(e.id)}
                  >
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

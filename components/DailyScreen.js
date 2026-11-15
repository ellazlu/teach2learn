'use client';

import { useEffect, useState } from 'react';
import { getLevel } from '../lib/levels.ts';
import { formatTime } from '../lib/client';

const USER_KEY = 'teach2learn-daily-user';
export function loadDailyUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}
export function saveDailyUser(u) {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(u));
  } catch {}
}

function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
}

// L2T Daily: same topic, student and objectives for everyone today. Scored on
// the server with the standard Learn to Teach rubric; best attempt counts.
export default function DailyScreen({ onStart, starting, error, onBack }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [username, setUsername] = useState('');
  const [now, setNow] = useState(Date.now());
  const [offset, setOffset] = useState(0); // server clock - local clock

  async function load() {
    setLoadError('');
    const u = loadDailyUser();
    if (u?.username) setUsername((x) => x || u.username);
    try {
      const res = await fetch(`/api/daily${u?.userId ? `?userId=${encodeURIComponent(u.userId)}` : ''}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`);
      setData(d);
      setOffset(d.now - Date.now());
    } catch (e) {
      setLoadError(e.message);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // A new day: fetch the new challenge and board.
  useEffect(() => {
    if (data && now + offset >= data.nextResetAt) load();
  }, [now]);

  const ch = data?.challenge;
  const board = data?.leaderboard;
  const me = board?.me;

  return (
    <div className="daily">
      <div className="page-head">
        <button className="btn-text" onClick={onBack}>← Back</button>
        <h1>L2T Daily</h1>
        <span />
      </div>

      {loadError && (
        <div className="center-block">
          <p className="error">{loadError}</p>
          <button className="btn" onClick={load}>Try again</button>
        </div>
      )}
      {!data && !loadError && <div className="center-block"><div className="spinner" aria-hidden /></div>}

      {ch && (
        <div className="daily-grid">
          <section className="panel daily-challenge">
            <p className="eyebrow">Daily challenge · {new Date(`${ch.day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })} (UTC)</p>
            <h2>{ch.topic}</h2>
            <p className="muted">Teach a {getLevel(ch.levelId).label.toLowerCase()} in {formatTime(ch.timeLimitSec)}. Everyone gets the same student, with the same starting knowledge.</p>
            <h3 className="label">Objectives</h3>
            <ol className="objectives">
              {ch.objectives.map((o) => <li key={o}>{o}</li>)}
            </ol>
            <div className="daily-stats">
              <div><span className="stat-k">Your best today</span><span className="stat-v">{me ? `${me.score}` : '–'}</span></div>
              <div><span className="stat-k">Your rank</span><span className="stat-v">{me ? `${me.rank} of ${board.total}` : '–'}</span></div>
              <div><span className="stat-k">Next challenge in</span><span className="stat-v mono">{countdown(data.nextResetAt - (now + offset))}</span></div>
            </div>
            <form
              className="daily-start"
              onSubmit={(e) => {
                e.preventDefault();
                onStart(username.trim(), ch);
              }}
            >
              <input className="input" placeholder="Username for the leaderboard" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={20} aria-label="Username" />
              <button className="btn primary large" type="submit" disabled={starting || username.trim().length < 2}>
                {starting ? 'Starting…' : me ? 'Try again' : 'Start'}
              </button>
            </form>
            {error && <p className="error small">{error}</p>}
            <p className="fine">Scored out of 100 with the standard Learn to Teach rubric, on the server. Retry as often as you like (up to 15 tries a day); only your best counts. Resets at midnight UTC.</p>
          </section>

          <section className="panel daily-board">
            <div className="panel-head">
              <h2 className="label">Leaderboard</h2>
              <span className="muted small">{board.total} player{board.total === 1 ? '' : 's'}</span>
            </div>
            {board.entries.length === 0 ? (
              <p className="muted">No scores yet today. Be the first.</p>
            ) : (
              <table className="data">
                <thead><tr><th className="num">Rank</th><th>Username</th><th className="num">Score</th></tr></thead>
                <tbody>
                  {board.entries.map((e) => (
                    <tr key={`${e.rank}-${e.username}`} className={e.me ? 'me' : ''}>
                      <td className="num">{e.rank}</td>
                      <td>{e.username}{e.me && <span className="tag">you</span>}</td>
                      <td className="num"><strong>{e.score}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {me && me.rank > board.entries.length && <p className="small muted">You: #{me.rank} with {me.score}.</p>}
            {data.storage === 'file' && <p className="fine">Leaderboard stored on this server's disk.</p>}
          </section>
        </div>
      )}
    </div>
  );
}

// Shown on the results page after a Daily attempt.
export function DailyBanner({ daily, onOpen }) {
  if (!daily) return null;
  return (
    <div className="daily-banner">
      <span className="mode-tag">L2T Daily</span>
      {daily.status === 'pending' && <span className="muted">Submitting your attempt…</span>}
      {daily.status === 'failed' && <span className="error">Not submitted: {daily.error}</span>}
      {daily.status === 'done' && (
        <span>
          {daily.eligible ? (
            <>Official score <strong>{daily.score}/100</strong> (scored on the server)</>
          ) : (
            <span className="muted">Didn't count: {daily.reasons.join(' ')}</span>
          )}
          {daily.best && <> · best today <strong>{daily.best.score}</strong></>}
          {daily.rank && <> · rank {daily.rank} of {daily.total}</>}
        </span>
      )}
      <button className="btn-text small" onClick={onOpen}>Leaderboard</button>
    </div>
  );
}

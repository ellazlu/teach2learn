'use client';

import { useState } from 'react';
import { getLevel } from '../lib/levels.ts';
import { formatTime } from '../lib/client';
import { CATEGORIES, CATEGORY_LABEL, SKILLS } from '../lib/coach/rubric.ts';
import { describeCriterion } from '../lib/coach/challenges.ts';
import { StudentProfile } from './ResultsScreen';
import { currentChallenge, practiceEffect, recurringWeaknesses, seriesForChart } from '../lib/progress.ts';

// Categorical palette (validated with the dataviz validator against #fff).
// Teaching's aqua has low contrast, so every series is also direct-labeled and
// there's a table view.
export const SERIES_COLOR = { engagement: '#2a78d6', communication: '#eb6834', teaching: '#1baf7a' };
const SHORT = { engagement: 'Engagement', communication: 'Communication', teaching: 'Teaching' };
const STATUS = { improving: ['Improving', 'ok'], persisting: ['Still showing up', 'bad'], not_enough_evidence: ['Not enough evidence', 'neutral'] };
const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function ProgressScreen({ profile, onStartChallenge, onOpenSession, onBack }) {
  const sessions = profile.sessions;
  const rated = sessions.filter((s) => CATEGORIES.some((c) => s.ratings[c] !== null));
  const ch = currentChallenge(profile);
  const recurring = recurringWeaknesses(profile);
  const past = profile.challenges.filter((c) => c.status !== 'active' && c.attempts.length).slice(-4).reverse();

  return (
    <div className="progress">
      <div className="page-head">
        <button className="btn-text" onClick={onBack}>← Back</button>
        <h1>Progress</h1>
        <span />
      </div>

      {sessions.length === 0 ? (
        <p className="muted">Finish a session to start tracking your teaching. Each session is rated on engagement, communication and teaching effectiveness, and your coach sets a practice challenge.</p>
      ) : (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2 className="label">Scores over time</h2>
              <span className="muted small">{rated.length} rated session{rated.length === 1 ? '' : 's'} since {shortDate(sessions[0].at)}</span>
            </div>
            {rated.length === 0 ? (
              <p className="muted">No session has had enough evidence to rate yet.</p>
            ) : (
              <RatingsChart series={seriesForChart(profile)} />
            )}
          </section>

          <div className="progress-grid">
            <section className="panel">
              <h2 className="label">Current challenge</h2>
              {ch ? <CurrentChallenge ch={ch} profile={profile} onStart={onStartChallenge} /> : <p className="muted">Your coach sets one after each rated session.</p>}
              {past.length > 0 && (
                <div className="past">
                  <h3 className="small muted">Earlier challenges</h3>
                  <ul className="plain-rows">
                    {past.map((c) => {
                      const best = Math.max(...c.attempts.map((a) => a.met));
                      return (
                        <li key={c.id}>
                          <span>{c.title} <span className="muted">· {SKILLS[c.skill].label}</span></span>
                          <span className="muted small">{c.status === 'completed' ? 'met' : `best ${best}/${c.criteria.length}`} · {c.attempts.length} attempt{c.attempts.length === 1 ? '' : 's'}</span>
                          {c.status !== 'completed' && <button className="btn-text" onClick={() => onStartChallenge({ ...c, status: 'active' })}>Retry</button>}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </section>

            <section className="panel">
              <h2 className="label">Recurring areas to improve</h2>
              {recurring.length === 0 ? (
                <p className="muted">{rated.length < 2 ? 'Shows up after two or more rated sessions.' : 'Nothing has come up in more than one recent session.'}</p>
              ) : (
                <ul className="recurring">
                  {recurring.map((r) => (
                    <li key={r.skill}>
                      <div className="cs-row">
                        <span className="concept-name">{r.label}</span>
                        <span className={`status ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
                      </div>
                      <p className="small muted">
                        In {r.count} of your last {r.window} sessions.
                        {r.practice ? ` Practised in ${r.practice.attempts} challenge attempt${r.practice.attempts === 1 ? '' : 's'}; best ${r.practice.bestMet}/${r.practice.bestTotal} criteria met.` : ' Not practised yet.'}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="panel">
            <h2 className="label">Recent sessions</h2>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Date</th><th>Topic</th><th>Level</th><th className="num">Overall</th>{CATEGORIES.map((c) => <th key={c} className="num">{SHORT[c]}</th>)}<th>Coach focus</th></tr>
                </thead>
                <tbody>
                  {[...sessions].reverse().slice(0, 10).map((s) => (
                    <tr key={s.id} onClick={() => onOpenSession(s.id)} className="clickable">
                      <td>{shortDate(s.at)}</td>
                      <td>{s.topic}{s.challengeId && <span className="tag">challenge</span>}</td>
                      <td>{getLevel(s.levelId).label}</td>
                      <td className="num"><strong>{s.ratings.overall ?? <span className="muted" title="Not enough evidence">–</span>}</strong></td>
                      {CATEGORIES.map((c) => <td key={c} className="num">{s.ratings[c] ?? <span className="muted" title="Not enough evidence">–</span>}</td>)}
                      <td className="muted">{s.focusSkill ? SKILLS[s.focusSkill].label : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {profile.lastCoachLog && <CoachLog log={profile.lastCoachLog} />}
        </>
      )}
    </div>
  );
}

function CurrentChallenge({ ch, profile, onStart }) {
  const effect = practiceEffect(profile, ch);
  const cat = SKILLS[ch.skill].category;
  return (
    <div className="current">
      <h3>{ch.title}</h3>
      <p>{ch.goal}</p>
      <StudentProfile text={ch.scenario.studentProfile} />
      <ul className="criteria">
        {ch.criteria.map((c, i) => <li key={i}><span className="crit na">○</span>{describeCriterion(c)}</li>)}
      </ul>
      {ch.attempts.length > 0 && (
        <div className="table-wrap">
          <table className="data compact">
            <thead>
              <tr><th>Attempt</th>{ch.criteria.map((c, i) => <th key={i} className="num" title={describeCriterion(c)}>#{i + 1}</th>)}<th className="num">{SHORT[cat]}</th></tr>
            </thead>
            <tbody>
              <tr><td className="muted">Before (session that set it)</td>{ch.criteria.map((_, i) => <td key={i} />)}<td className="num">{effect.before ?? '–'}</td></tr>
              {ch.attempts.map((a, n) => (
                <tr key={a.sessionId}>
                  <td>{n + 1} · {shortDate(a.at)}</td>
                  {a.results.map((r, i) => <td key={i} className={`num crit ${r.met === true ? 'ok' : r.met === false ? 'bad' : 'na'}`}>{r.met === true ? '✓' : r.met === false ? '✗' : '–'}</td>)}
                  <td className="num">{effect.attempts[n]?.rating ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button className="btn primary large" onClick={() => onStart(ch)}>{ch.attempts.length ? 'Retry challenge' : 'Start challenge'}</button>
      <p className="fine">{getLevel(ch.scenario.levelId).label} · {formatTime(ch.scenario.timeLimitSec)} · {ch.scenario.topic}</p>
    </div>
  );
}

function CoachLog({ log }) {
  return (
    <details className="coach-log">
      <summary>Coach activity (last review)</summary>
      <p className="small muted">
        {log.agent === 'deepagents' ? 'Deep Agents coach' : 'Deterministic coach'}{log.error ? ` · ${log.error}` : ''}
      </p>
      <ol>
        {log.log.map((e, i) => (
          <li key={i} className={`log-${e.type}`}>
            <span className="ts">+{(e.ms / 1000).toFixed(1)}s</span>
            <span className="log-type">{e.type}</span>
            <span className="log-name">{e.name}</span>
            <span className="log-detail">{e.detail}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

// ---- Line chart: three categories, 1-5, one point per session -------------------------------

const W = 680, H = 230, M = { l: 30, r: 170, t: 14, b: 30 };

export function RatingsChart({ series }) {
  const [hover, setHover] = useState(null);
  const [asTable, setAsTable] = useState(false);
  const n = series[0].points.length;
  const x = (i) => M.l + (n <= 1 ? (W - M.l - M.r) / 2 : (i * (W - M.l - M.r)) / (n - 1));
  const y = (v) => M.t + ((100 - v) * (H - M.t - M.b)) / 100;
  // Ratings are whole numbers, so equal values would hide each other: give
  // each series a small fixed vertical offset.
  const OFF = { engagement: -2, communication: 0, teaching: 2 };
  // Break the line at missing ratings rather than bridging them.
  const segments = (pts, off) => {
    const out = [];
    let cur = [];
    pts.forEach((p, i) => {
      if (p.value === null) { if (cur.length) out.push(cur); cur = []; } else cur.push([x(i), y(p.value) + off]);
    });
    if (cur.length) out.push(cur);
    return out;
  };
  // End labels sit at the last rated point, nudged apart so they don't collide.
  const ends = series
    .map((s) => {
      let last = -1;
      s.points.forEach((p, i) => { if (p.value !== null) last = i; });
      return last < 0 ? null : { category: s.category, value: s.points[last].value, y: y(s.points[last].value), x: x(last), stale: last !== n - 1 };
    })
    .filter(Boolean)
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;

  const dates = series[0].points.map((p) => shortDate(p.at));
  const uniqueDates = new Set(dates).size === dates.length;
  const tick = (p, i) => (uniqueDates ? dates[i] : `#${i + 1}`);
  const when = (p) => `${shortDate(p.at)} ${new Date(p.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  const anchor = (i) => (n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle');

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setHover(best);
  };

  return (
    <div className="chart">
      <div className="chart-bar">
        <ul className="legend">
          {series.map((s) => (
            <li key={s.category}><span className="swatch" style={{ background: SERIES_COLOR[s.category] }} />{CATEGORY_LABEL[s.category]}</li>
          ))}
        </ul>
        <button className="btn-text small" onClick={() => setAsTable((t) => !t)}>{asTable ? 'Show chart' : 'Show as table'}</button>
      </div>

      {asTable ? (
        <div className="table-wrap">
          <table className="data compact">
            <thead><tr><th>Session</th>{series.map((s) => <th key={s.category} className="num">{SHORT[s.category]}</th>)}</tr></thead>
            <tbody>
              {series[0].points.map((p, i) => (
                <tr key={p.id}><td>{shortDate(p.at)} · {p.topic}</td>{series.map((s) => <td key={s.category} className="num">{s.points[i].value ?? '–'}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-plot">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Scores from 0 to 100 for each session" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            {[0, 25, 50, 75, 100].map((v) => (
              <g key={v}>
                <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} className="grid" />
                <text x={M.l - 10} y={y(v) + 4} className="axis" textAnchor="end">{v}</text>
              </g>
            ))}
            {series[0].points.map((p, i) => (n <= 8 || i % Math.ceil(n / 8) === 0 || i === n - 1) && (
              <text key={p.id} x={x(i)} y={H - 8} className="axis" textAnchor={anchor(i)}>{tick(p, i)}</text>
            ))}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={H - M.b} className="crosshair" />}
            {series.map((s) => (
              <g key={s.category}>
                {segments(s.points, OFF[s.category]).map((seg, k) =>
                  seg.length > 1 ? (
                    <polyline key={k} points={seg.map((p) => p.join(',')).join(' ')} fill="none" stroke={SERIES_COLOR[s.category]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                  ) : null
                )}
                {s.points.map((p, i) => p.value !== null && (
                  <circle key={p.id} cx={x(i)} cy={y(p.value) + OFF[s.category]} r={hover === i ? 5 : 4} fill={SERIES_COLOR[s.category]} stroke="#fff" strokeWidth="2" />
                ))}
              </g>
            ))}
            {ends.map((e) => (
              <text key={e.category} x={W - M.r + 10} y={e.y + 4} className="end-label">
                {SHORT[e.category]} {e.value}{e.stale ? ' (earlier)' : ''}
              </text>
            ))}
          </svg>
          {hover !== null && (
            <div className={`tooltip ${x(hover) / W > 0.55 ? 'flip' : ''}`} style={{ left: `${(x(hover) / W) * 100}%` }}>
              <div className="tt-head">{uniqueDates ? '' : `Session ${hover + 1} · `}{when(series[0].points[hover])}</div>
              <div className="tt-sub">{series[0].points[hover].topic}</div>
              {series.map((s) => (
                <div key={s.category} className="tt-row">
                  <span className="swatch" style={{ background: SERIES_COLOR[s.category] }} />
                  <span>{SHORT[s.category]}</span>
                  <span className="tt-v">{s.points[hover].value ?? 'not enough evidence'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

'use client';

import { formatTime } from '../lib/client';
import { getLevel } from '../lib/levels.ts';
import { fmt } from '../lib/student/speech.ts';
import { Turn } from './SessionScreen';
import { CATEGORIES, CATEGORY_LABEL, OVERALL_WEIGHTS } from '../lib/coach/rubric.ts';
import { describeCriterion, plainReason } from '../lib/coach/challenges.ts';
import { rateRecord } from '../lib/coach/record.ts';

const STATUS_CLS = {
  'Demonstrated understanding': 'ok',
  'Partially understood': 'mid',
  'Not yet verified': 'neutral',
};
const MIS = { active: 'Still believes', partially_addressed: 'Unsure now', resolved: 'Corrected' };

export default function ResultsScreen({ entry, attemptNumber, isHistory, footer, nextChallenge, attemptedChallenge, onStartChallenge, onRetryCoach }) {
  if (entry.version !== 4) return <LegacyResults entry={entry} isHistory={isHistory} footer={footer} />;
  const level = getLevel(entry.levelId);
  const { teaching, concepts, metrics, finalModel } = entry;
  const ratings = rateRecord(entry).scores;
  const exchanges = entry.utterances.filter((u) => u.speaker === 'student').length;
  const avgLatency = entry.latencies?.length ? entry.latencies.reduce((a, b) => a + b, 0) / entry.latencies.length / 1000 : null;
  const attempt = attemptedChallenge?.attempts.find((a) => a.sessionId === entry.id) || null;

  return (
    <div className="results">
      <header className="results-head">
        <p className="eyebrow">
          {level.label} · {formatTime(entry.timeUsedSec)} of {formatTime(entry.timeLimitSec)} · {exchanges} student {exchanges === 1 ? 'reply' : 'replies'}
          {attemptNumber > 1 && ` · attempt ${attemptNumber}`}
          {isHistory && ` · ${new Date(entry.createdAt).toLocaleString()}`}
        </p>
        <h1>{entry.topicTitle}</h1>
      </header>

      <section className="scores" aria-label="Scores">
        <div className="overall">
          <span className="rating-label">Overall</span>
          {ratings.overall === null ? <span className="rating-na">Not enough evidence</span> : <span className="overall-score">{ratings.overall}<span className="of">/100</span></span>}
          <span className="fine">{CATEGORIES.map((c) => `${CATEGORY_LABEL[c].split(' ')[0]} ${Math.round(OVERALL_WEIGHTS[c] * 100)}%`).join(' · ')}</span>
        </div>
        <div className="ratings">
          {CATEGORIES.map((c) => (
            <Rating key={c} label={CATEGORY_LABEL[c]} rating={ratings[c]} />
          ))}
        </div>
      </section>

      <div className="results-grid">
        <section>
          <h2 className="label">Your teaching</h2>
          <dl className="three">
            <Item term="What went well" item={teaching.went_well} empty="Nothing specific stood out yet. Try checking that the student understood." />
            <Item term="What to improve" item={teaching.improve} empty="No clear weak spot in this session." />
            <Item term="Try next time" item={teaching.try_next} empty="Teach the next concept and have the student explain it back." />
          </dl>
        </section>

        <ChallengeCard
          coach={entry.coach}
          next={nextChallenge}
          attempted={attemptedChallenge}
          attempt={attempt}
          onStart={onStartChallenge}
          onRetry={onRetryCoach}
        />
      </div>

      <section>
        <h2 className="label">Student understanding</h2>
        <ul className="concept-summary">
          {concepts.map((c) => (
            <li key={c.conceptId}>
              <div className="cs-row">
                <span className="concept-name">{c.name}</span>
                <span className={`status ${STATUS_CLS[c.status]}`}>{c.status}</span>
              </div>
              {c.note && <p className="cs-note">{c.note}</p>}
            </li>
          ))}
        </ul>
        {finalModel?.misconceptions?.length > 0 && (
          <ul className="mis-list">
            {finalModel.misconceptions.map((m) => (
              <li key={m.id}>
                <span className={`status ${m.status === 'resolved' ? 'ok' : m.status === 'active' ? 'bad' : 'mid'}`}>{MIS[m.status]}</span>
                <span>
                  {m.belief}
                  {!m.expressed && m.status === 'active' && <span className="muted"> (never came up)</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="fine">A concept counts as understood only when the student explained or applied it correctly.</p>
      </section>

      <details className="evidence-details">
        <summary>Evidence and how ratings work</summary>
        <div className="evidence-body">
          {(entry.evidence || []).length > 0 ? (
            <ul className="evidence-list">
              {entry.evidence.map((e) => (
                <li key={e.id}>
                  <span className={`ev-mark ${e.positive ? 'pos' : 'neg'}`} aria-label={e.positive ? 'went well' : 'issue'}>{e.positive ? '+' : '−'}</span>
                  <span className="ts">{e.at !== null ? fmt(e.at) : '—'}</span>
                  <span>
                    {e.label}
                    {e.quote && <q className="ev-quote">{e.quote}</q>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No evidence was recorded in this session.</p>
          )}

          {metrics?.teacherWords > 0 && (
            <div className="stats">
              <Stat k="Pace" v={metrics.wordsPerMinute ? `${metrics.wordsPerMinute} wpm` : 'not measured'} />
              <Stat k="Longest stretch" v={metrics.longestRun ? `${Math.round(metrics.longestRun.seconds)}s` : 'n/a'} />
              <Stat k="Your share of talk" v={metrics.teacherShare !== null ? `${Math.round(metrics.teacherShare * 100)}%` : 'n/a'} />
              <Stat k="Check-ins" v={String(metrics.checksForUnderstanding.length)} />
              <Stat k="Student reply delay" v={avgLatency !== null ? `${avgLatency.toFixed(1)}s` : 'n/a'} />
            </div>
          )}

          <div className="rubric">
            {CATEGORIES.map((c) => (
              <div key={c} className="rubric-item">
                <h3>{CATEGORY_LABEL[c]}</h3>
                <table className="criteria-table">
                  <tbody>
                    {(ratings[c].criteria || []).map((k) => (
                      <tr key={k.id} className={k.value === null ? 'na' : ''}>
                        <td>
                          <span className="crit-label">{k.label}</span>
                          <span className="small muted"> {k.detail}</span>
                        </td>
                        <td className="num">{k.value === null ? <span className="muted" title="Not judged in this session; its weight is spread over the others">n/a</span> : `${Math.round(k.value * k.weight)}/${k.weight}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <p className="fine">Scores use fixed, weighted criteria measured from the session, so they're comparable across sessions. Criteria that couldn't be judged (n/a) have their weight spread over the rest. Pauses, accent and speaking style never lower a score; pace and fillers count only when measured; basic, age-appropriate words never count as jargon.</p>
          </div>
        </div>
      </details>

      <details className="transcript-details">
        <summary>Transcript</summary>
        <div className="convo static">
          {entry.utterances.length ? entry.utterances.map((u) => <Turn key={u.id} u={u} />) : <p className="muted">Nothing was captured.</p>}
        </div>
      </details>

      {footer}
    </div>
  );
}

function Rating({ label, rating }) {
  const s = rating.score;
  return (
    <div className="rating">
      <div className="rating-top">
        <span className="rating-label">{label}</span>
        {s === null ? <span className="rating-na">Not enough evidence</span> : <span className="rating-score">{s}<span className="of">/100</span></span>}
      </div>
      <div className="bar" role="img" aria-label={s === null ? 'not rated' : `${s} out of 100`}>
        <span style={{ width: `${s ?? 0}%` }} />
      </div>
      <p className="rating-why">{s === null ? rating.explanation.replace(/^Not enough evidence: /, '').replace(/^./, (c) => c.toUpperCase()) : rating.explanation}</p>
    </div>
  );
}

const VERDICT = {
  addressed: ['Challenge met', 'ok'],
  partly_addressed: ['Partly met', 'mid'],
  not_addressed: ['Not met yet', 'bad'],
  not_enough_evidence: ['Not enough evidence', 'neutral'],
};

// Who the simulated student will be in the challenge (it plays this role).
export function StudentProfile({ text }) {
  if (!text) return null;
  return (
    <div className="persona">
      <span className="persona-label">Your student</span>
      <p>{text}</p>
    </div>
  );
}

function ChallengeCard({ coach, next, attempted, attempt, onStart, onRetry }) {
  const status = coach?.status;
  const outcome = coach?.outcome;
  return (
    <section className="challenge-card">
      <h2 className="label">Next challenge</h2>
      {attempted && attempt && (
        <div className="outcome">
          <div className="cs-row">
            <span className="concept-name">{attempted.title}</span>
            {outcome && <span className={`status ${VERDICT[outcome.verdict]?.[1]}`}>{VERDICT[outcome.verdict]?.[0]}</span>}
          </div>
          <ul className="criteria">
            {attempt.results.map((r, i) => (
              <li key={i}>
                <span className={`crit ${r.met === true ? 'ok' : r.met === false ? 'bad' : 'na'}`}>{r.met === true ? '✓' : r.met === false ? '✗' : '–'}</span>
                {describeCriterion(r)}
                <span className="muted"> · {r.actual === null ? 'not enough evidence' : `you: ${r.actual}${r.metric === 'questions_answered_ratio' ? '%' : r.metric === 'max_run_seconds' ? 's' : ''}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(!status || status === 'pending') && (
        <p className="muted coach-pending"><span className="spinner small" aria-hidden /> Your coach is reviewing this session…</p>
      )}
      {status === 'failed' && (
        <div>
          <p className="muted">The coach couldn't review this session{coach.error ? ` (${coach.error})` : ''}.</p>
          <button className="btn" onClick={onRetry}>Try again</button>
        </div>
      )}
      {status === 'done' && !next && (
        <p className="muted">{coach.reason ? `${plainReason(coach.reason)} ` : ''}Not enough evidence in this session to set a new challenge. Your current challenge stays the same.</p>
      )}
      {status === 'done' && next && (
        <div className="next">
          <h3>{next.title}</h3>
          <p>{next.goal}</p>
          <StudentProfile text={next.scenario.studentProfile} />
          <ul className="criteria">
            {next.criteria.map((c, i) => <li key={i}><span className="crit na">○</span>{describeCriterion(c)}</li>)}
          </ul>
          {coach.reason && <p className="small"><span className="muted">Why: </span>{plainReason(coach.reason)}</p>}
          {outcome?.adjustment && <p className="small muted">{outcome.adjustment}</p>}
          <button className="btn primary large" onClick={() => onStart(next)}>
            {attempted && next.id === attempted.id ? 'Retry challenge' : 'Start next challenge'}
          </button>
          <p className="fine">
            {getLevel(next.scenario.levelId).label} · {formatTime(next.scenario.timeLimitSec)} · {next.scenario.topic}
          </p>
        </div>
      )}
    </section>
  );
}

function Item({ term, item, empty }) {
  return (
    <div className="three-item">
      <dt>{term}</dt>
      <dd>
        {item ? item.text : <span className="muted">{empty}</span>}
        {item?.evidence && (item.evidence.quote || item.evidence.at !== null) && (
          <span className="evidence">
            {item.evidence.at !== null && <span className="ts">{fmt(item.evidence.at)}</span>}
            {item.evidence.quote ? <q>{item.evidence.quote}</q> : <span className="muted">{item.evidence.label}</span>}
          </span>
        )}
      </dd>
    </div>
  );
}

function Stat({ k, v }) {
  return (
    <div className="stat">
      <span className="stat-v">{v}</span>
      <span className="stat-k">{k}</span>
    </div>
  );
}

function LegacyResults({ entry, isHistory, footer }) {
  const level = getLevel(entry.levelId);
  return (
    <div className="results">
      <header className="results-head">
        <p className="eyebrow">
          {level.label} · {formatTime(entry.timeUsedSec)}
          {isHistory && ` · ${new Date(entry.createdAt).toLocaleString()}`} · earlier format
        </p>
        <h1>{entry.topicTitle}</h1>
        {entry.summary && <p>{entry.summary}</p>}
      </header>
      {entry.suggestions.length > 0 && (
        <section>
          <h2 className="label">Suggestions</h2>
          <ol className="plain-list">{entry.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </section>
      )}
      <details className="transcript-details">
        <summary>Transcript</summary>
        <p className="pre">{entry.transcript || 'Nothing was captured.'}</p>
      </details>
      {footer}
    </div>
  );
}

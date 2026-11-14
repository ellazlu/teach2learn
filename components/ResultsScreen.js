'use client';

import { formatTime } from '../lib/client';
import { getLevel } from '../lib/levels.ts';
import { fmt } from '../lib/student/speech.ts';
import { Turn } from './SessionScreen';

const STATUS_CLS = {
  'Demonstrated understanding': 'ok',
  'Partially understood': 'mid',
  'Not yet verified': 'neutral',
};
const MIS = { active: 'Still believes', partially_addressed: 'Unsure now', resolved: 'Corrected' };

export default function ResultsScreen({ entry, attemptNumber, isHistory, footer }) {
  if (entry.version !== 4) return <LegacyResults entry={entry} isHistory={isHistory} footer={footer} />;
  const level = getLevel(entry.levelId);
  const { teaching, concepts, metrics, finalModel } = entry;
  const exchanges = entry.utterances.filter((u) => u.speaker === 'student').length;
  const avgLatency = entry.latencies?.length ? entry.latencies.reduce((a, b) => a + b, 0) / entry.latencies.length / 1000 : null;

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

      <div className="results-grid">
        <section>
          <h2 className="label">Your teaching</h2>
          <dl className="three">
            <Item term="What went well" item={teaching.went_well} empty="Nothing specific stood out yet. Try checking that the student understood." />
            <Item term="What to improve" item={teaching.improve} empty="No clear weak spot in this session." />
            <Item term="Try next time" item={teaching.try_next} empty="Teach the next concept and have the student explain it back." />
          </dl>
          {entry.usedFallback && <p className="fine">Based directly on session evidence.</p>}
        </section>

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
      </div>

      {metrics?.teacherWords > 0 && (
        <section className="stats">
          <Stat k="Pace" v={metrics.wordsPerMinute ? `${metrics.wordsPerMinute} wpm` : 'n/a'} />
          <Stat k="Longest stretch" v={metrics.longestRun ? `${Math.round(metrics.longestRun.seconds)}s` : 'n/a'} />
          <Stat k="Your share of talk" v={metrics.teacherShare !== null ? `${Math.round(metrics.teacherShare * 100)}%` : 'n/a'} />
          <Stat k="Check-ins" v={String(metrics.checksForUnderstanding.length)} />
          <Stat k="Student reply delay" v={avgLatency !== null ? `${avgLatency.toFixed(1)}s` : 'n/a'} />
        </section>
      )}

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

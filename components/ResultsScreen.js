'use client';

import { formatTime } from '../lib/client';
import { getLevel } from '../lib/levels.ts';
import { fmt } from '../lib/student/speech.ts';
import { ConceptBar } from './StudentPanel';
import { Turn } from './SessionScreen';

const MIS = {
  active: { label: 'Still believes it', cls: 'bad' },
  partially_addressed: { label: 'Unsure now', cls: 'mid' },
  resolved: { label: 'Resolved', cls: 'good' },
};

export default function ResultsScreen({ entry, attemptNumber, isHistory, footer }) {
  if (entry.version !== 3) return <LegacyResults entry={entry} isHistory={isHistory} footer={footer} />;
  const level = getLevel(entry.levelId);
  const { feedback, learning, metrics, finalModel, initialModel } = entry;
  const questions = entry.utterances.filter((u) => u.speaker === 'student').length;

  return (
    <div className="stack">
      <section className="card">
        <p className="eyebrow">
          {level.emoji} Taught to {level.label.toLowerCase()} · ⏱ {formatTime(entry.timeUsedSec)} of {formatTime(entry.timeLimitSec)} · 🙋 {questions} interjection{questions === 1 ? '' : 's'}
          {attemptNumber > 1 && ` · attempt ${attemptNumber}`}
          {isHistory && ` · ${new Date(entry.createdAt).toLocaleString()}`}
        </p>
        <h2>{entry.topicTitle}</h2>
        <p className="summary">{feedback.summary}</p>
      </section>

      {finalModel && finalModel.concepts.length > 0 && (
        <section className="card">
          <h2>🧠 What your student learned</h2>
          <p className="muted tiny">Simulated estimates of the virtual student's understanding, not a measurement of real learning.</p>
          <ul className="concept-bars big">
            {finalModel.concepts.map((c) => (
              <ConceptBar key={c.id} concept={c} from={initialModel?.concepts.find((x) => x.id === c.id)?.mastery} />
            ))}
          </ul>
          <div className="learn-grid">
            {learning.stillConfusing.length > 0 && (
              <div>
                <p className="panel-sub">Still confusing</p>
                <ul className="plain">
                  {learning.stillConfusing.map((c) => <li key={c.conceptId}><strong>{c.name}</strong> <span className="muted">· {c.why}</span></li>)}
                </ul>
              </div>
            )}
            {learning.notCovered.length > 0 && (
              <div>
                <p className="panel-sub">Not covered</p>
                <ul className="plain">{learning.notCovered.map((c) => <li key={c.conceptId}>{c.name}</li>)}</ul>
              </div>
            )}
          </div>
          {finalModel.misconceptions.length > 0 && (
            <>
              <p className="panel-sub">Misconceptions</p>
              <ul className="mis-list">
                {finalModel.misconceptions.map((m) => (
                  <li key={m.id}>
                    <span className={`tag ${MIS[m.status].cls}`}>{MIS[m.status].label}</span>
                    <span>
                      “{m.belief}”{!m.expressed && m.status === 'active' && <span className="muted"> (never came up)</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {feedback.suggestions.length > 0 && (
        <section className="card">
          <h2>How to teach this better</h2>
          <ol className="suggestion-list">
            {feedback.suggestions.map((s, i) => (
              <li key={i}>
                <strong>{s.title}</strong>
                <p>{s.detail}</p>
                <EvidenceList items={s.evidence} />
              </li>
            ))}
          </ol>
          {feedback.usedFallback && <p className="muted tiny">The AI coach was unavailable, so these were generated directly from the session evidence.</p>}
        </section>
      )}

      {feedback.strengths.length > 0 && (
        <section className="card">
          <h2>✨ What worked</h2>
          <ul className="feedback-list">
            {feedback.strengths.map((s, i) => (
              <li key={i} className="good-item">
                <p>{s.point}</p>
                <EvidenceList items={s.evidence} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <SpeakingPatterns metrics={metrics} />

      {feedback.outside_knowledge.length > 0 && (
        <section className="card">
          <h2>🌱 Beyond your material</h2>
          <ul className="feedback-list">
            {feedback.outside_knowledge.map((o, i) => (
              <li key={i} className={o.correct ? 'good-item' : 'bad-item'}>
                <strong>{o.correct ? '👏' : '✋'} {o.term_or_idea}</strong>
                <p>{o.comment}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        {entry.extraction && (
          <details>
            <summary>📘 Topic overview</summary>
            <div className="details-body">
              <p>{entry.extraction.overview}</p>
              <ul className="concepts">
                {entry.extraction.concepts.map((c) => (
                  <li key={c.id}>
                    <strong>{c.name}</strong>: {c.description}
                    {c.keyTerms.length > 0 && <div className="terms">{c.keyTerms.map((t) => <span key={t} className="term">{t}</span>)}</div>}
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}
        <details>
          <summary>💬 Full conversation</summary>
          <div className="convo static">
            {entry.utterances.length ? entry.utterances.map((u) => <Turn key={u.id} u={u} level={level} />) : <p className="muted">(nothing captured)</p>}
          </div>
        </details>
      </section>

      {footer}
    </div>
  );
}

// Only show evidence that adds something: a moment in time or the actual words.
function EvidenceList({ items }) {
  const shown = (items || []).filter((e) => e.at !== null || e.quote);
  if (!shown.length) return null;
  return (
    <ul className="evidence">
      {shown.map((e) => (
        <li key={e.id}>
          {e.at !== null && <span className="ts">{fmt(e.at)}</span>}
          {e.quote ? <q>{e.quote}</q> : <span className="muted">{e.label}</span>}
        </li>
      ))}
    </ul>
  );
}

function SpeakingPatterns({ metrics: m }) {
  if (!m || !m.teacherWords) return null;
  const stats = [
    m.wordsPerMinute ? { k: 'Pace', v: `${m.wordsPerMinute} wpm`, note: 'while speaking' } : { k: 'Pace', v: '—', note: 'not enough timed speech' },
    m.longestRun ? { k: 'Longest stretch', v: `${Math.round(m.longestRun.seconds)}s`, note: `at ${fmt(m.longestRun.start)}` } : null,
    m.teacherShare !== null ? { k: 'Your share of talk', v: `${Math.round(m.teacherShare * 100)}%`, note: 'vs the student' } : null,
    { k: 'Check-ins', v: String(m.checksForUnderstanding.length), note: 'asked if they understood' },
    { k: 'Long pauses', v: String(m.longPauses.length), note: '4s or more' },
    { k: 'Fillers', v: String(m.fillerCount), note: Object.entries(m.fillers).map(([w, n]) => `${w} ×${n}`).join(', ') || 'none detected' },
  ].filter(Boolean);
  const avgResp = m.responseLatencies.length
    ? Math.round(m.responseLatencies.reduce((a, r) => a + r.seconds, 0) / m.responseLatencies.length)
    : null;
  return (
    <section className="card">
      <h2>🎙️ How you spoke</h2>
      <div className="stats">
        {stats.map((s) => (
          <div key={s.k} className="stat">
            <span className="stat-v">{s.v}</span>
            <span className="stat-k">{s.k}</span>
            <span className="muted tiny">{s.note}</span>
          </div>
        ))}
      </div>
      <p className="muted tiny">
        {avgResp !== null && `You took ${avgResp >= 1 ? `about ${avgResp}s` : 'under a second'} on average to start answering the student's questions. `}
        Measured from speech-recognition timestamps, so treat these as approximate. Pauses and pace aren't good or bad on their own:
        what matters is whether your student had room to follow and to speak up. Speech recognition often drops “um” and “uh”, so filler
        counts are a lower bound.
      </p>
    </section>
  );
}

function LegacyResults({ entry, isHistory, footer }) {
  const level = getLevel(entry.levelId);
  return (
    <div className="stack">
      <section className="card">
        <p className="eyebrow">
          {level.emoji} {level.label} · ⏱ {formatTime(entry.timeUsedSec)}
          {isHistory && ` · ${new Date(entry.createdAt).toLocaleString()}`} · older session format
        </p>
        <h2>{entry.topicTitle}</h2>
        {entry.summary && <p className="summary">{entry.summary}</p>}
      </section>
      {entry.suggestions.length > 0 && (
        <section className="card">
          <h2>Suggestions</h2>
          <ol className="suggestion-list">{entry.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </section>
      )}
      <section className="card">
        <details>
          <summary>🗣️ Transcript</summary>
          <p className="details-body">{entry.transcript || '(nothing captured)'}</p>
        </details>
      </section>
      {footer}
    </div>
  );
}

import { quoteAppearsIn } from './verify.js';

const POINTS = { met: 1, partial: 0.5, missing: 0 };

export function scoreResults(results) {
  const counts = { met: 0, partial: 0, missing: 0 };
  let points = 0;
  for (const r of results) {
    counts[r.status]++;
    points += POINTS[r.status];
  }
  const total = results.length;
  return { ...counts, total, points, percent: total ? Math.round((points / total) * 100) : 0 };
}

// Turn the model's raw grading into the final result, enforcing the rules in code:
// - every rubric item gets a result (anything the model skipped counts as missing)
// - credit requires an evidence quote that really appears in the transcript
// - misconceptions and outside-knowledge items must quote the transcript too
// - outside knowledge must be tied to a real concept from the source
export function finalizeGrade(raw, plan, transcript) {
  const byId = new Map((raw.rubric_results || []).map((r) => [r.rubric_id, r]));

  const results = plan.rubric.map((item) => {
    const r = byId.get(item.id) || { status: 'missing', evidence_quote: '', reason: 'Not covered.' };
    let status = POINTS[r.status] !== undefined ? r.status : 'missing';
    let reason = r.reason || '';
    let evidence = (r.evidence_quote || '').trim();
    let downgraded = false;
    if (status !== 'missing' && !quoteAppearsIn(evidence, transcript)) {
      reason = `The grader marked this "${status}", but its supporting quote couldn't be found in your transcript, so no credit was given.`;
      status = 'missing';
      downgraded = true;
    }
    if (status === 'missing') evidence = '';
    return { ...item, status, evidence_quote: evidence, reason, downgraded };
  });

  const conceptIds = new Set(plan.concepts.map((c) => c.id));

  return {
    results,
    score: scoreResults(results),
    misconceptions: (raw.misconceptions || []).filter((m) => quoteAppearsIn(m.user_quote, transcript)),
    outside_knowledge: (raw.outside_knowledge || []).filter(
      (o) => conceptIds.has(o.related_concept_id) && quoteAppearsIn(o.user_quote, transcript)
    ),
    lost_moments: raw.lost_moments || [],
    suggestions: raw.suggestions || [],
    summary: raw.summary || '',
  };
}

export function emptyGrade(plan) {
  const results = plan.rubric.map((item) => ({
    ...item,
    status: 'missing',
    evidence_quote: '',
    reason: 'Nothing was taught.',
    downgraded: false,
  }));
  return {
    results,
    score: scoreResults(results),
    misconceptions: [],
    outside_knowledge: [],
    lost_moments: [],
    suggestions: ['No speech was captured. Check that your microphone is allowed, or use "Type instead".'],
    summary: 'No speech was captured during this session, so nothing could be graded.',
  };
}

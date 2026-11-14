// Code-level checks that keep the AI honest: every quote it claims came from the
// source (or from the student's transcript) must actually be there.

export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// True if `quote` appears in `text`. Exact match after normalizing, or a fuzzy
// match where at least `minOverlap` of the quote's words show up in one nearby
// window of the text (tolerates speech-recognition slips and small edits).
export function quoteAppearsIn(quote, text, minOverlap = 0.8) {
  const q = normalize(quote);
  const t = normalize(text);
  if (!q || !t) return false;
  if (t.includes(q)) return true;

  const qw = q.split(' ');
  const tw = t.split(' ');
  if (qw.length < 3) return false; // short quotes must match exactly
  const win = qw.length + Math.ceil(qw.length * 0.25);
  const last = Math.max(0, tw.length - qw.length);
  for (let i = 0; i <= last; i++) {
    const counts = new Map();
    for (const w of tw.slice(i, i + win)) counts.set(w, (counts.get(w) || 0) + 1);
    let hit = 0;
    for (const w of qw) {
      const c = counts.get(w);
      if (c) {
        hit++;
        counts.set(w, c - 1);
      }
    }
    if (hit / qw.length >= minOverlap) return true;
  }
  return false;
}

// Drop any concept or rubric item whose source_quote can't be found in a text
// source. PDFs/images can't be checked server-side, so those items are kept
// with verified: null.
export function verifyPlan(plan, sources) {
  const textSources = sources.filter((s) => s.kind === 'text');
  const allText = sources.length > 0 && textSources.length === sources.length;

  const check = (item) => {
    const src = sources.find((s) => s.name === item.source_name);
    let haystack = null;
    if (src) {
      if (src.kind === 'text') haystack = src.data;
    } else if (allText) {
      haystack = textSources.map((s) => s.data).join('\n');
    }
    if (haystack === null) return { ...item, verified: null };
    return { ...item, verified: quoteAppearsIn(item.source_quote, haystack, 0.9) };
  };

  const allConcepts = (plan.concepts || []).map(check);
  const concepts = allConcepts.filter((c) => c.verified !== false);
  const ids = new Set(concepts.map((c) => c.id));
  const allRubric = (plan.rubric || []).map(check);
  const rubric = allRubric
    .filter((r) => r.verified !== false)
    .map((r) => ({ ...r, concept_ids: (r.concept_ids || []).filter((id) => ids.has(id)) }));

  return {
    topic_title: plan.topic_title || 'Your topic',
    overview: plan.overview || '',
    concepts,
    rubric,
    dropped: allConcepts.length - concepts.length + (allRubric.length - rubric.length),
  };
}

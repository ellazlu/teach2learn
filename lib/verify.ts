// Code-level checks that keep the AI honest: every quote it claims the student
// said must actually be in the transcript.

export function normalize(s: unknown): string {
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
export function quoteAppearsIn(quote: unknown, text: unknown, minOverlap = 0.8): boolean {
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
    const counts = new Map<string, number>();
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

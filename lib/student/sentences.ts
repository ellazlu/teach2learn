// Splits streamed text into speakable sentences so audio can start on the
// first sentence instead of waiting for the whole reply.

export function takeSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    // "3.5", "e.g." and "..." in the middle of a sentence are not boundaries.
    const prev = buffer[i - 1] || '';
    const next = buffer[i + 1];
    if (ch === '.' && /\d/.test(prev) && next && /\d/.test(next)) continue;
    if (next === undefined) break; // might still be followed by more punctuation
    if (/[.!?"”')]/.test(next)) continue;
    if (!/\s/.test(next)) continue;
    const s = buffer.slice(start, i + 1).trim();
    if (s.split(/\s+/).length >= 2 || /[?!]$/.test(s)) {
      sentences.push(s);
      start = i + 1;
    }
  }
  return { sentences, rest: buffer.slice(start) };
}

export function flushSentences(buffer: string): string[] {
  const { sentences, rest } = takeSentences(buffer);
  const r = rest.trim();
  return r ? [...sentences, r] : sentences;
}

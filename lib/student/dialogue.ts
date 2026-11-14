// Keeps the student's lines specific. The LLM phrases the line; this module
// checks that it actually names what the student is stuck on (shares content
// words with the target: the open question, the teacher's quote, the term)
// and isn't a vague "can you explain it another way?". If the LLM keeps being
// vague, fallbackLine() builds a specific line from the target itself.

import { normalize } from '../verify.ts';

const GENERIC: RegExp[] = [
  /\bexplain (it|that|this|them)?\s*(again|another way|a different way|differently|more)\b/,
  /\bnot quite (there|getting it|following)\b/,
  /\bi (sort|kind) of get\b/,
  /\bcan you (clarify|elaborate|go over)\b/,
  /\bi('m| am) (still |a bit |a little )?(confused|lost)\b/,
  /\bwhat do you mean\b/,
  /\bi don't (really )?(get|understand) (it|that|this)\b/,
];

const STOP = new Set(
  'about after again also because been before being could does doing done from have here into just like more most much only other really should some such than that their them then there these they thing things this those through very what when where which while will with would your youre dont doesnt isnt cant wont sorry okay quite sort kind still mean means explain another different right wait maybe actually get gets got understand know think said says'.split(' ')
);

export function contentWords(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalize(s).replace(/'/g, '').split(' ')) {
    if (w.length < 4 || STOP.has(w)) continue;
    out.add(w.endsWith('s') && w.length > 4 ? w.slice(0, -1) : w);
  }
  return out;
}

export function isGeneric(text: string): boolean {
  const t = normalize(text);
  return GENERIC.some((re) => re.test(t));
}

// overlap: how many of the line's content words come from the target.
export function specificity(text: string, anchors: string[]): { ok: boolean; overlap: number; generic: boolean } {
  const words = contentWords(text);
  const target = new Set<string>();
  for (const a of anchors) for (const w of contentWords(a || '')) target.add(w);
  let overlap = 0;
  for (const w of words) if (target.has(w)) overlap++;
  const generic = isGeneric(text);
  if (!normalize(text)) return { ok: false, overlap, generic };
  if (!target.size) return { ok: !generic, overlap, generic };
  return { ok: overlap >= 1 && !(generic && overlap < 2), overlap, generic };
}

export interface LineDetails {
  term?: string;
  conceptName?: string;
  relatedName?: string;
  belief?: string;
  previousQuestion?: string;
  focusQuestion?: string;
}

const stripEnd = (s: string) => s.trim().replace(/[.?!]+$/, '');
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

// A plain but specific line, used only when the LLM won't produce one.
export function fallbackLine(intent: string, d: LineDetails): string {
  const concept = d.conceptName || 'that';
  if (d.focusQuestion) return `${stripEnd(d.focusQuestion)}?`;
  switch (intent) {
    case 'define_term':
      return `What does "${d.term || concept}" mean?`;
    case 'misconception':
      return d.belief ? `Wait, but I thought ${lowerFirst(stripEnd(d.belief))}?` : `Is that really how ${concept} works?`;
    case 'follow_up':
      return d.previousQuestion ? `I still don't get one part: ${lowerFirst(stripEnd(d.previousQuestion))}?` : `What about ${concept}?`;
    case 'relate':
      return `How does ${concept} connect to ${d.relatedName || 'what you said before'}?`;
    case 'prerequisite':
      return `Wait, what is ${concept}?`;
    case 'example':
      return `Can you give me an example of ${concept}?`;
    case 'challenge':
      return `Does that always work for ${concept}, or are there exceptions?`;
    default:
      return `Which part of ${concept} matters most here?`;
  }
}

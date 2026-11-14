// Turns the knowledge model into what the student "knows" for the reply
// prompt, so its replies change as it learns: unknown -> heard of it ->
// gets it (quoting what the teacher said) -> demonstrated. Misconceptions
// show up as beliefs until they're corrected.

import type { ConceptState, Segment, StudentModel } from './types.ts';
import { normalize } from '../verify.ts';

function understanding(c: ConceptState): string {
  const gaps = (c.openGaps || []).map((g) => g.question);
  const taught = [...new Set(c.evidence.filter((e) => e.delta > 0).map((e) => e.quote))].slice(-2).map((q) => `"${q}"`).join(' and ');
  if (c.verification === 'demonstrated') return `You understand this and already explained it back correctly.${taught ? ` You learned it from: ${taught}.` : ''}`;
  if (c.mastery >= 65) return `You understand this now.${taught ? ` The teacher explained: ${taught}.` : ''}`;
  if (c.explained) {
    return `You partly get this.${taught ? ` The teacher said: ${taught}.` : ''}${gaps.length ? ` You're still stuck on: ${gaps.join(' / ')}` : ''}`;
  }
  if (c.mentioned) return `You've heard the teacher mention it but it hasn't been explained yet.${gaps.length ? ` You wonder: ${gaps.join(' / ')}` : ''}`;
  return c.mastery >= 40 ? 'You know a little about this already.' : "You don't know about this yet.";
}

export function knowledgeForPrompt(model: StudentModel): string {
  const lines = model.concepts.map((c) => `- ${c.name}: ${understanding(c)}`);
  for (const m of model.misconceptions) {
    if (m.status === 'active') lines.push(`- You believe: "${m.belief}"`);
    else if (m.status === 'partially_addressed') lines.push(`- You used to believe "${m.belief}", but now you're not sure.`);
    else lines.push(`- You used to believe "${m.belief}", but the teacher showed you that's wrong.`);
  }
  return lines.join('\n');
}

// What the teacher has said about a concept (by name / key terms), for
// explain-back, answers, and verification. Falls back to the latest teaching.
export function taughtAbout(utterances: Segment[], c: ConceptState, maxChars = 700): string {
  const terms = [c.name, ...c.keyTerms].map(normalize).filter((t) => t.length >= 3);
  const teacher = utterances.filter((u) => u.speaker === 'teacher');
  const hits = teacher.filter((u) => {
    const t = ` ${normalize(u.text)} `;
    return terms.some((term) => t.includes(` ${term} `) || t.includes(` ${term.replace(/s$/, '')} `));
  });
  const chosen = hits.length ? hits : teacher.slice(-3);
  return chosen.map((u) => u.text).join(' ').slice(-maxChars);
}

// Teach to Learn routes, run for real with stand-ins for next/server and the SDK.
import assert from 'node:assert/strict';
import { POST as prepare } from './out/prepare.mjs';
import { POST as reply } from './out/reply.mjs';
import { POST as whiteboard } from './out/whiteboard.mjs';
import { POST as studyFeedback } from './out/study-feedback.mjs';
import { POST as studyPlan } from './out/study-plan.mjs';

process.env.ANTHROPIC_API_KEY = 'test';
process.env.COACH_LOG = 'off';
globalThis.__sdkCalls = [];
const req = (b) => new Request('http://x', { method: 'POST', body: JSON.stringify(b) });
const last = () => globalThis.__sdkCalls.at(-1);
const allStrict = (s) => { if (s && typeof s === 'object') { if (s.type === 'object') assert.equal(s.additionalProperties, false); Object.values(s).forEach(allStrict); } };

// ---- prepare (mode student): 5-10 concepts, names only ------------------------------
const concepts = Array.from({ length: 12 }, (_, i) => ({ id: `c${i + 1}`, name: `Concept ${i + 1}.`, description: `what c${i + 1} must say`, difficulty: 2, prerequisites: i ? [`c${i}`] : [], key_terms: [`term${i + 1}`] }));
globalThis.__sdkReply = () => ({ topic_title: 'Photosynthesis', overview: 'o', concepts, misconceptions: [{ id: 'm1', concept_id: 'c3', belief: 'O2 from CO2', correction: 'from water' }] });
let r = await prepare(req({ topic: 'Photosynthesis', levelId: 'high', sources: [], mode: 'student' }));
const ext = await r.json();
assert.equal(r.status, 200);
assert.equal(ext.concepts.length, 10, 'checklist capped at 10');
assert.equal(ext.concepts[0].name, 'Concept 1', 'short names');
assert.match(last().system, /5-10 most important ideas/);
assert.match(last().system, /prerequisites first/);
r = await prepare(req({ topic: 'Photosynthesis', levelId: 'high', sources: [] }));
assert.equal((await r.json()).concepts.length, 3, 'Learn to Teach still extracts 1-3 key concepts');
assert.match(last().system, /1-3 KEY concepts/);
console.log('✓ /api/prepare mode=student: 5-10 concept checklist (Learn to Teach unchanged)');

// ---- reply (mode student): curious student, never gives answers -------------------------
globalThis.__streamChunks = ['Why ', 'light?'];
r = await reply(req({ mode: 'student', levelId: 'high', intent: 'error_check', details: { conceptName: 'Oxygen', conceptDescription: 'O2 comes from splitting water.', focusQuote: 'oxygen comes from CO2' }, outline: ['Basics', 'Oxygen'], board: { transcription: 'CO2 -> O2', description: 'arrow' }, knowledge: '', conversation: [], teacherJustSaid: 'the oxygen comes from CO2' }));
assert.equal(await r.text(), 'Why light?');
const sys = last().system;
assert.match(sys, /test and deepen their OWN understanding/);
assert.match(sys, /never give answers/);
const text = last().messages[0].content[0].text;
assert.match(text, /<private_notes>[\s\S]*never say this/);
assert.match(text, /<whiteboard>\nWritten: CO2 -> O2/);
assert.match(text, /They said: "oxygen comes from CO2"[\s\S]*Never say it's wrong/);
r = await reply(req({ levelId: 'high', intent: 'clarify', details: { conceptName: 'x' }, knowledge: '', conversation: [], teacherJustSaid: 'y' }));
await r.text();
assert.doesNotMatch(last().system, /OWN understanding/, 'Learn to Teach reply prompt unchanged');
console.log('✓ /api/reply mode=student: probing student prompt with private notes + whiteboard context');

// ---- whiteboard: vision request, cleaned output, unclear parts never guessed ------------------
globalThis.__sdkReply = () => ({ transcription: '6CO2 + 6H2O -> C6H12O6 + 6O2', description: 'a leaf with arrows', concept_ids: ['c1', 'c9'], unclear: [{ part: 'label on the left', question: 'Is that ATP?' }], blank: false });
r = await whiteboard(req({ image: 'iVBORw0KGgo=', mediaType: 'image/png', topic: 'P', concepts: [{ id: 'C1', name: 'Basics' }], recentSpeech: 'so this arrow', id: 'w1', at: 12, trigger: 'share' }));
const board = await r.json();
assert.equal(r.status, 200);
assert.deepEqual(board.conceptIds, ['c1']);
assert.equal(board.unclear[0].question, 'Is that ATP?');
assert.equal(last().messages[0].content[0].type, 'image');
assert.equal(last().messages[0].content[0].source.media_type, 'image/png');
assert.match(last().system, /NEVER guess/);
allStrict(last().output_config.format.schema);
assert.equal((await whiteboard(req({ image: '', concepts: [] }))).status, 400);
assert.equal((await whiteboard(req({ image: 'abc', mediaType: 'image/gif' }))).status, 400);
globalThis.__sdkReply = () => new Error('vision down');
assert.equal((await whiteboard(req({ image: 'abc', concepts: [] }))).status, 500, 'failure reported; the session keeps going without it');
console.log('✓ /api/whiteboard: image sent to the vision model, unknown concepts dropped, unclear parts returned as questions');

// ---- study feedback: content only, validated, fallback ---------------------------------
const learner = {
  version: 1, focusConceptIds: [], board: { latest: null, pendingClarify: null, fresh: false, askedClarify: [] },
  concepts: [
    { id: 'c1', name: 'Basics', coverage: 'discussed', mentioned: true, depth: 1, explanations: [{ segmentId: 's1', at: 3, quote: 'plants make sugar from light', correctness: 'correct', clarity: 'clear', source: 'speech' }], probes: [], errors: [], omissions: [], whiteboard: [] },
    { id: 'c2', name: 'Oxygen', coverage: 'discussed', mentioned: true, depth: 0, explanations: [{ segmentId: 's2', at: 9, quote: 'oxygen comes from CO2', correctness: 'incorrect', clarity: 'clear', source: 'speech' }], probes: [], errors: [{ segmentId: 's2', at: 9, quote: 'oxygen comes from CO2', source: 'speech', kind: 'incorrect', corrected: false, correctedQuote: '' }], omissions: [], whiteboard: [] },
    { id: 'c3', name: 'Calvin cycle', coverage: 'not_covered', mentioned: false, depth: 0, explanations: [], probes: [], errors: [], omissions: [], whiteboard: [] },
  ],
};
const extraction = { topicTitle: 'P', overview: '', fromMaterial: false, concepts: [{ id: 'c1', name: 'Basics', description: 'd1', prerequisites: [] }, { id: 'c2', name: 'Oxygen', description: 'O2 comes from water', prerequisites: ['c1'] }, { id: 'c3', name: 'Calvin cycle', description: 'd3', prerequisites: [] }], misconceptions: [] };
const utterances = [{ id: 'u1', speaker: 'teacher', text: 'okay so plants make sugar from light and the oxygen comes from CO2 which they breathe in through tiny holes in the leaves during the day', start: 0, end: 9 }];
globalThis.__sdkReply = (p) => {
  const ids = p.output_config.format.schema.properties.correct.properties.evidence_ids.items.enum;
  return { correct: { text: 'You explained the basics accurately.', evidence_ids: [ids[0]] }, gaps: { text: 'You never reached the Calvin cycle.', evidence_ids: [ids.at(-1)] }, misconceptions: [{ evidence_id: ids[1], what_was_off: 'The oxygen comes from splitting water, not CO2.' }], review_next: { concept_id: 'c2', text: 'Revisit where the oxygen comes from.' } };
};
r = await studyFeedback(req({ learner, extraction, utterances, boards: [], topicTitle: 'P' }));
let out = await r.json();
assert.equal(out.feedback.usedFallback, false);
assert.equal(out.feedback.misconceptions[0].note, 'The oxygen comes from splitting water, not CO2.');
assert.equal(out.feedback.reviewNext.conceptId, 'c2');
assert.doesNotMatch(last().system + JSON.stringify(out), /engagement|professionalism|words per minute/i);
assert.match(last().system, /never comment on delivery/);
globalThis.__sdkReply = () => new Error('down');
out = await (await studyFeedback(req({ learner, extraction, utterances, boards: [], topicTitle: 'P' }))).json();
assert.equal(out.feedback.usedFallback, true);
assert.equal(out.feedback.reviewNext.conceptId, 'c2');
assert.equal((await studyFeedback(req({}))).status, 400);
console.log('✓ /api/study-feedback: content-only, citations checked, deterministic fallback');

// ---- study plan: Deep Agents not installed here -> deterministic planner ------------------
const session = { version: 'study1', mode: 'student', id: 't1', createdAt: '2026-11-14T10:00:00Z', topicTitle: 'P', topicKey: 'p', levelId: 'high', timeLimitSec: 300, timeUsedSec: 90, extraction, learner, utterances, boards: [], manualChecked: [], feedback: out.feedback, evidence: out.evidence, practiceId: null, plan: null };
r = await studyPlan(req({ session, history: null }));
const plan = await r.json();
assert.equal(r.status, 200);
assert.equal(plan.agent, 'fallback');
assert.match(plan.error, /Deep Agents unavailable/);
assert.equal(plan.analysis.priority.conceptId, 'c2');
assert.equal(plan.practice.conceptId, 'c2');
assert.ok(plan.log.some((l) => l.name === 'rank_knowledge_gaps'));
assert.equal((await studyPlan(req({ session: { id: 'x' } }))).status, 400);
console.log('✓ /api/study-plan: gap analysis + practice saved; graceful fallback without Deep Agents');
console.log('\nALL TEACH TO LEARN ROUTE CHECKS PASSED');

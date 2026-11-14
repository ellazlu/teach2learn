import assert from 'node:assert/strict';
import { POST as prepare } from './out/prepare.mjs';
import { POST as evaluate } from './out/evaluate.mjs';
import { POST as speak } from './out/speak.mjs';
import { POST as feedback } from './out/feedback.mjs';
process.env.ANTHROPIC_API_KEY = 'test';
globalThis.__sdkCalls = [];
const req = (b) => new Request('http://x', { method: 'POST', body: JSON.stringify(b) });
const allStrict = (s) => { if (s && typeof s === 'object') { if (s.type === 'object') assert.equal(s.additionalProperties, false); Object.values(s).forEach(allStrict); } };

// prepare
globalThis.__sdkReply = () => ({ topic_title: 'Photosynthesis', overview: 'o', concepts: [
  { id: 'C1', name: 'Basics', description: 'd', difficulty: 1, prerequisites: [], key_terms: ['photosynthesis'] },
  { id: 'c2', name: 'Chlorophyll', description: 'd', difficulty: 2, prerequisites: ['c1', 'c9'], key_terms: [] }],
  misconceptions: [{ id: 'M1', concept_id: 'c1', belief: 'Plants eat soil', correction: 'They make food' }] });
let r = await prepare(req({ topic: 'Photosynthesis', levelId: 'middle', sources: [] }));
let ext = await r.json();
assert.equal(r.status, 200);
assert.deepEqual(ext.concepts.map((c) => c.id), ['c1', 'c2']);
assert.deepEqual(ext.concepts[1].prerequisites, ['c1']);
assert.equal(ext.misconceptions[0].conceptId, 'c1');
assert.equal(ext.fromMaterial, false);
let call = globalThis.__sdkCalls.at(-1);
assert.equal(call.output_config.format.type, 'json_schema');
allStrict(call.output_config.format.schema);
assert.match(call.system, /No material was uploaded/);
r = await prepare(req({ topic: '', sources: [] }));
assert.equal(r.status, 400);
console.log('✓ /api/prepare: structured output, sanitized ids/prereqs, topic-only mode, validation');

// evaluate: dynamic enums
globalThis.__sdkReply = () => ({ concepts: [{ concept_id: 'C1', explained: true, correctness: 'Correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'x y z' }], misconceptions: [], undefined_terms: [], question_response: { quality: 'none', quote: '' }, checked_understanding: { happened: false, quote: '' } });
r = await evaluate(req({ levelId: 'middle', segment: 'x y z', model: { concepts: [{ id: 'c1' }, { id: 'c2' }], misconceptions: [{ id: 'm1' }] } }));
const prop = await r.json();
assert.equal(prop.concepts[0].concept_id, 'c1');
assert.equal(prop.concepts[0].correctness, 'correct');
call = globalThis.__sdkCalls.at(-1);
assert.deepEqual(call.output_config.format.schema.properties.concepts.items.properties.concept_id.enum, ['c1', 'c2']);
allStrict(call.output_config.format.schema);
// no misconceptions -> plain string, not an empty enum
await evaluate(req({ levelId: 'middle', segment: 'x', model: { concepts: [{ id: 'c1' }], misconceptions: [] } }));
assert.equal(globalThis.__sdkCalls.at(-1).output_config.format.schema.properties.misconceptions.items.properties.misconception_id.enum, undefined);
globalThis.__sdkReply = () => new Error('rate limited');
r = await evaluate(req({ levelId: 'middle', segment: 'x', model: { concepts: [{ id: 'c1' }], misconceptions: [] } }));
assert.equal(r.status, 500);
console.log('✓ /api/evaluate: dynamic id enums, lowercased enums, errors surface as 500');

// speak
globalThis.__sdkReply = () => ({ text: '"Wait, do plants eat dirt?"' });
r = await speak(req({ levelId: 'kindergarten', intent: 'misconception', details: { belief: 'Plants eat soil' }, teacherSaid: 'plants', whatYouKnow: '', alreadyAsked: [] }));
assert.equal((await r.json()).text, 'Wait, do plants eat dirt?');
assert.match(globalThis.__sdkCalls.at(-1).messages[0].content[0].text, /You genuinely believe: "Plants eat soil"/);
console.log('✓ /api/speak: intent comes from the app, quotes stripped');

// feedback: LLM path cites evidence; uncited dropped; LLM failure -> fallback
const { initStudentModel } = await import('./out/knowledge.mjs');
const extraction = { ...ext, concepts: ext.concepts };
const initial = initStudentModel(extraction, 'middle');
const utterances = [{ id: 'u1', speaker: 'teacher', text: 'the thylakoid does stuff and plants are neat', start: 5, end: 9 }];
const events = [{ type: 'undefined_term', segmentId: 's1', at: 5, term: 'thylakoid', quote: 'the thylakoid does stuff' }];
globalThis.__sdkReply = (p) => ({ summary: 'S', suggestions: [{ title: 'Define thylakoid', detail: 'At 0:05…', evidence_ids: ['E1'] }, { title: 'Be clearer', detail: 'generic', evidence_ids: [] }], strengths: [], outside_knowledge: [{ term_or_idea: 'x', student_quote: 'not said at all here', correct: true, comment: 'c' }] });
r = await feedback(req({ levelId: 'middle', topicTitle: 'P', initial, final: initial, events, utterances, sources: [] }));
let fb = await r.json();
assert.equal(fb.suggestions.length, 1);
assert.equal(fb.suggestions[0].evidence[0].at, 5);
assert.equal(fb.outside_knowledge.length, 0, 'unverifiable quote dropped');
assert.equal(fb.usedFallback, false);
assert.deepEqual(globalThis.__sdkCalls.at(-1).output_config.format.schema.properties.suggestions.items.properties.evidence_ids.items.enum, fb.evidence.map((e) => e.id));
globalThis.__sdkReply = () => new Error('overloaded');
fb = await (await feedback(req({ levelId: 'middle', topicTitle: 'P', initial, final: initial, events, utterances, sources: [] }))).json();
assert.equal(fb.usedFallback, true);
assert.ok(fb.suggestions.length >= 1);
fb = await (await feedback(req({ levelId: 'middle', topicTitle: 'P', events: [], utterances: [] }))).json();
assert.match(fb.summary, /No speech was captured/);
console.log('✓ /api/feedback: evidence enum, uncited suggestions dropped, LLM failure -> evidence fallback, missing model handled');
console.log('\nALL ROUTE CHECKS PASSED');

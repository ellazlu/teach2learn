import assert from 'node:assert/strict';
import { POST as prepare } from './out/prepare.mjs';
import { POST as evaluate } from './out/evaluate.mjs';
import { POST as reply } from './out/reply.mjs';
import { POST as verify } from './out/verify.mjs';
import { GET as ttsGet, POST as ttsPost } from './out/tts.mjs';
import { POST as feedback } from './out/feedback.mjs';
import { POST as coach } from './out/coach.mjs';

process.env.ANTHROPIC_API_KEY = 'test';
globalThis.__sdkCalls = [];
const req = (b, signal) => new Request('http://x', { method: 'POST', body: JSON.stringify(b), signal });
const allStrict = (s) => { if (s && typeof s === 'object') { if (s.type === 'object') assert.equal(s.additionalProperties, false); Object.values(s).forEach(allStrict); } };
const last = () => globalThis.__sdkCalls.at(-1);

// ---- prepare: 1-3 key concepts --------------------------------------------------
globalThis.__sdkReply = () => ({ topic_title: 'Photosynthesis', overview: 'o', concepts: [
  { id: 'C1', name: 'Basics', description: 'Plants make sugar from light', difficulty: 1, prerequisites: [], key_terms: ['photosynthesis'] },
  { id: 'c2', name: 'Chlorophyll', description: 'd', difficulty: 2, prerequisites: ['c1', 'c9'], key_terms: [] },
  { id: 'c3', name: 'Light reactions', description: 'd', difficulty: 3, prerequisites: ['c2'], key_terms: [] },
  { id: 'c4', name: 'Calvin cycle', description: 'd', difficulty: 4, prerequisites: ['c3'], key_terms: [] }],
  misconceptions: [{ id: 'M1', concept_id: 'c1', belief: 'Plants eat soil', correction: 'They make food' }] });
let r = await prepare(req({ topic: 'Photosynthesis', levelId: 'middle', sources: [] }));
const ext = await r.json();
assert.equal(r.status, 200);
assert.deepEqual(ext.concepts.map((c) => c.id), ['c1', 'c2', 'c3'], 'capped at 3 key concepts');
assert.deepEqual(ext.concepts[1].prerequisites, ['c1']);
assert.match(last().system, /1-3 KEY concepts/);
allStrict(last().output_config.format.schema);
r = await prepare(req({ topic: 'Photosynthesis', levelId: 'middle', sources: [], misconception: 'Plants eat soil' }));
assert.match(last().messages[0].content.at(-1).text, /first misconception must be this belief[^\n]*Plants eat soil/);
console.log('✓ /api/prepare: 1-3 key concepts, sanitized, structured output, challenge misconception passed through');

// ---- evaluate: dynamic enums, gap field -------------------------------------------
globalThis.__sdkReply = () => ({ concepts: [{ concept_id: 'C1', explained: true, correctness: 'Correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'x y z', gap: '' }], misconceptions: [], undefined_terms: [], question_response: { quality: 'none', quote: '' }, checked_understanding: { happened: false, quote: '' } });
r = await evaluate(req({ levelId: 'middle', segment: 'x y z', model: { concepts: [{ id: 'c1' }, { id: 'c2' }], misconceptions: [{ id: 'm1' }] } }));
const prop = await r.json();
assert.equal(prop.concepts[0].concept_id, 'c1');
assert.deepEqual(last().output_config.format.schema.properties.concepts.items.properties.concept_id.enum, ['c1', 'c2']);
assert.ok(last().output_config.format.schema.properties.concepts.items.required.includes('gap'));
console.log('✓ /api/evaluate: dynamic id enums, specific gap field');

// ---- reply: streamed plain text ----------------------------------------------------
globalThis.__streamChunks = ['Wait, ', "don't plants ", 'get food from the soil?'];
const body = { levelId: 'middle', intent: 'misconception', details: { belief: 'Plants get their food from the soil.' }, knowledge: '- You believe: "Plants get their food from the soil."', taught: '', conversation: [], teacherJustSaid: 'plants make their own food', alreadySaid: [] };
r = await reply(req(body));
assert.equal(r.status, 200);
assert.match(r.headers.get('content-type'), /text\/plain/);
const reader = r.body.getReader();
const dec = new TextDecoder();
const parts = [];
for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(dec.decode(value)); }
assert.ok(parts.length >= 3, `streamed in ${parts.length} chunks`);
assert.equal(parts.join(''), "Wait, don't plants get food from the soil?");
const sent = last();
assert.equal(sent.max_tokens, 160);
assert.match(sent.messages[0].content[0].text, /<teacher_just_said>\nplants make their own food/);
assert.match(sent.messages[0].content[0].text, /You genuinely believe: "Plants get their food from the soil\."/);
assert.match(sent.system, /bright and you learn from good explanations/);
// a practice challenge's student profile reaches the student's prompt
globalThis.__streamChunks = ['ok'];
r = await reply(req({ ...body, persona: 'Rarely says when it is lost.' }));
await r.text();
assert.match(last().messages[0].content[0].text, /<who_you_are_today>\nRarely says when it is lost\./);
assert.doesNotMatch(sent.messages[0].content[0].text, /who_you_are_today/, 'no persona block without a challenge');
// abort mid-stream stops the model call
globalThis.__streamChunks = Array.from({ length: 50 }, () => 'word ');
globalThis.__streamAborted = false;
const ac = new AbortController();
r = await reply(req(body, ac.signal));
const rd = r.body.getReader();
await rd.read();
ac.abort();
await rd.cancel().catch(() => {});
await new Promise((res) => setTimeout(res, 30));
assert.equal(globalThis.__streamAborted, true, 'model stream aborted when the client goes away');
console.log('✓ /api/reply: streams text chunks, sees exactly what the teacher said, aborts with the client');

// ---- verify ----------------------------------------------------------------------------
globalThis.__sdkReply = () => ({ verdict: 'Demonstrated', note: 'Says plants make sugar from light.' });
r = await verify(req({ levelId: 'middle', concept: { name: 'Basics', description: 'Plants make sugar from light' }, mode: 'explain_back', statement: 'so plants make sugar using light?', taught: 'plants make food from light' }));
assert.deepEqual(await r.json(), { verdict: 'demonstrated', note: 'Says plants make sugar from light.' });
assert.match(last().messages[0].content[0].text, /<student_statement mode="explain_back">/);
globalThis.__sdkReply = () => ({ verdict: 'amazing', note: '' });
r = await verify(req({ levelId: 'middle', concept: { name: 'B', description: 'd' }, mode: 'answer', statement: 'x' }));
assert.equal((await r.json()).verdict, 'not_demonstrated', 'unknown verdicts never count as understanding');
console.log('✓ /api/verify: graded against the material, strict verdicts');

// ---- tts -------------------------------------------------------------------------------
delete process.env.ELEVENLABS_API_KEY;
assert.deepEqual(await (await ttsGet()).json(), { provider: 'browser' });
assert.equal((await ttsPost(req({ text: 'hi' }))).status, 404);
process.env.ELEVENLABS_API_KEY = 'el-test';
process.env.ELEVENLABS_VOICE_ID_YOUNG = 'kidvoice';
let upstreamReq;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { upstreamReq = { url, init }; return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }); };
assert.deepEqual(await (await ttsGet()).json(), { provider: 'elevenlabs' });
r = await ttsPost(req({ text: 'Wait, really?', levelId: 'middle' }));
assert.equal(r.status, 200);
assert.equal(r.headers.get('content-type'), 'audio/mpeg');
assert.equal((await r.arrayBuffer()).byteLength, 3);
assert.match(upstreamReq.url, /\/v1\/text-to-speech\/kidvoice\/stream\?output_format=mp3_44100_128$/);
assert.equal(upstreamReq.init.headers['xi-api-key'], 'el-test');
const tb = JSON.parse(upstreamReq.init.body);
assert.equal(tb.model_id, 'eleven_flash_v2_5');
assert.equal(tb.text, 'Wait, really?');
globalThis.fetch = async () => new Response('bad voice', { status: 422 });
assert.equal((await ttsPost(req({ text: 'x', levelId: 'expert' }))).status, 502, 'upstream errors surface so the client falls back');
globalThis.fetch = realFetch;
delete process.env.ELEVENLABS_API_KEY;
console.log('✓ /api/tts: ElevenLabs Flash v2.5 stream proxy (key stays server-side), browser fallback without a key');

// ---- feedback: exactly three evidence-backed items + concept summary --------------------
const { initStudentModel, applyEvaluation, applyVerification } = await import('./out/knowledge.mjs');
const extraction = { topicTitle: 'P', overview: '', fromMaterial: false, concepts: ext.concepts, misconceptions: ext.misconceptions };
const initial = initStudentModel(extraction, 'middle');
const seg = { id: 's1', speaker: 'teacher', text: 'the thylakoid does stuff and plants make sugar from light', start: 5, end: 9 };
let final = applyEvaluation(initial, seg, { concepts: [{ concept_id: 'c1', explained: true, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'plants make sugar from light', gap: '' }], misconceptions: [], undefined_terms: [{ term: 'thylakoid', quote: 'the thylakoid does stuff' }], question_response: { quality: 'none', quote: '' }, checked_understanding: { happened: false, quote: '' } });
const events = [...final.events];
final = final.model;
const v = applyVerification(final, 'c1', { at: 40, mode: 'explain_back', text: 'so plants make sugar from light?', verdict: 'demonstrated', note: 'right' });
final = v.model;
events.push(...v.events);
const utterances = [seg, { id: 'u2', speaker: 'student', text: 'so plants make sugar from light?', start: 40, end: 42 }];
// Like the model, pick evidence ids by reading the numbered evidence list in the prompt.
const idFor = (p, re) => p.messages[0].content[0].text.split('\n').find((l) => re.test(l))?.split(' ')[0];
globalThis.__sdkReply = (p) => ({
  went_well: { text: 'At 0:40 your explanation landed.', evidence_id: idFor(p, /correctly explained back/) },
  improve: { text: 'You used "thylakoid" without defining it.', evidence_id: idFor(p, /thylakoid/) },
  try_next: { text: 'Define new terms in plain words first.', evidence_id: idFor(p, /thylakoid/) },
});
r = await feedback(req({ levelId: 'middle', topicTitle: 'P', initial, final, events, utterances }));
let fb = await r.json();
assert.deepEqual(Object.keys(fb.teaching), ['went_well', 'improve', 'try_next']);
assert.equal(fb.teaching.went_well.evidence.kind, 'demonstrated');
assert.equal(fb.teaching.went_well.text, 'Your explanation landed.', 'invented timestamp stripped');
assert.equal(fb.teaching.improve.evidence.kind, 'undefined_term');
assert.equal(fb.concepts.find((c) => c.conceptId === 'c1').status, 'Demonstrated understanding');
assert.equal(fb.concepts.find((c) => c.conceptId === 'c2').status, 'Not yet verified');
assert.equal(fb.usedFallback, false);
globalThis.__sdkReply = () => new Error('overloaded');
fb = await (await feedback(req({ levelId: 'middle', topicTitle: 'P', initial, final, events, utterances }))).json();
assert.equal(fb.usedFallback, true);
assert.ok(fb.teaching.improve.evidence);
fb = await (await feedback(req({ levelId: 'middle', topicTitle: 'P', events: [], utterances: [] }))).json();
assert.equal(fb.spoke, false);
console.log('✓ /api/feedback: three evidence-backed items, concept summary from verification, fallback without the LLM');

// ---- coach: runs after feedback; Deep Agents isn't installed here -> fallback -------------
process.env.COACH_LOG = 'off';
const long = { id: 'u0', speaker: 'teacher', text: 'so plants are like little factories that take in light and water and air and then they turn all of that into sugar which is food for the plant and the thylakoid helps with that part', start: 0, end: 4 };
const fbFull = await (await feedback(req({ levelId: 'middle', topicTitle: 'P', initial, final, events, utterances: [long, ...utterances] }))).json();
const session = { version: 4, id: 'sess1', createdAt: '2026-11-14T10:00:00Z', topicTitle: 'P', levelId: 'middle', timeLimitSec: 120, timeUsedSec: 60,
  utterances: [long, ...utterances], events, initialModel: initial, finalModel: final, metrics: fbFull.metrics, evidence: fbFull.evidence, teaching: fbFull.teaching, challengeId: null };
r = await coach(req({ session, history: null, activeChallenge: null }));
assert.equal(r.status, 200);
let co = await r.json();
assert.equal(co.agent, 'fallback');
assert.match(co.error, /Deep Agents unavailable/, 'missing package detected at runtime, not at build');
assert.equal(co.ratings.communication.score, 3, 'one undefined term');
assert.ok(co.evaluation.focusSkill && co.challenge.criteria.length >= 1);
assert.ok(co.log.some((l) => l.type === 'tool' && l.name === 'score_session'));
delete process.env.ANTHROPIC_API_KEY;
co = await (await coach(req({ session, history: null, activeChallenge: null }))).json();
assert.match(co.error, /No ANTHROPIC_API_KEY/);
assert.equal((await coach(req({ session: { id: 'x' } }))).status, 400, 'malformed input rejected');
assert.equal((await coach(new Request('http://x', { method: 'POST', body: 'nope' }))).status, 400);
process.env.ANTHROPIC_API_KEY = 'test';
console.log('✓ /api/coach: rubric ratings, focus + challenge saved, graceful fallback without Deep Agents or a key');
console.log('\nALL ROUTE CHECKS PASSED');

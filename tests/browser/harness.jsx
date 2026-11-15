// Browser harness: runs the REAL app UI + SessionEngine with a simulated
// microphone (Web Speech API), voice, and API. Simulated API latencies are set
// in window.__lat so conversation latency can be measured end to end.
// Built and driven by tests/browser/run.mjs.

import { createRoot } from 'react-dom/client';
import Home from '../../app/page.js';
import { EXTRACTION } from '../fixtures.ts';
import { computeSpeechMetrics } from '../../lib/student/speech.ts';
import { learningSummary, conceptSummary } from '../../lib/student/knowledge.ts';
import { buildEvidence, fallbackThree } from '../../lib/student/evidence.ts';
import { runLocalCoach } from '../../lib/coach/record.ts';
import { cleanStudyExtraction } from '../../lib/learner/checklist.ts';
import { buildStudyEvidence, fallbackStudyFeedback, reviewCandidates } from '../../lib/learner/feedback.ts';
import { cleanBoard } from '../../lib/learner/whiteboard.ts';
import { createPlannerState } from '../../lib/study/tools.ts';
import { runFallbackPlanner } from '../../lib/study/fallback.ts';

// Teach to Learn checklist: the three fixture concepts plus three more.
const STUDY_EXT = cleanStudyExtraction({
  ...EXTRACTION,
  concepts: [
    ...EXTRACTION.concepts,
    { id: 'c4', name: 'Calvin cycle', description: 'Uses ATP and NADPH to fix carbon dioxide into sugar.', difficulty: 4, prerequisites: ['c3'], keyTerms: ['Calvin cycle'] },
    { id: 'c5', name: 'Limiting factors', description: 'Light, CO2 and temperature limit the rate.', difficulty: 3, prerequisites: ['c1'], keyTerms: ['limiting factor'] },
    { id: 'c6', name: 'Why leaves are green', description: 'Chlorophyll reflects green light.', difficulty: 2, prerequisites: ['c2'], keyTerms: ['green'] },
  ],
}, false);

window.__log = [];
const log = (x) => window.__log.push(x);
window.__lat = { evaluate: 1200, replyFirstToken: 400, replyChunk: 50, verify: 600 };
window.__calls = { evaluate: 0, reply: [], verify: 0, feedback: 0, coach: [], prepare: [], personas: [], replyBodies: [], whiteboard: [], studyFeedback: [], studyPlan: [], evalSegments: [] };
window.__studyPlanFail = false;
window.__coachFail = false;
window.__failNextEvaluate = false;
window.__ttsCalls = [];

// ---- Fake speech recognition: the test "speaks" with window.__teacherSays(text)
class FakeRecognition {
  constructor() {
    this.active = false;
    this.results = [];
    window.__rec = this;
  }
  start() {
    if (this.active) throw new Error('already started');
    this.active = true;
    this.results = [];
    log('mic:start');
  }
  stop() {
    if (!this.active) return;
    this.active = false;
    log('mic:stop');
    setTimeout(() => this.onend && this.onend(), 30);
  }
}
window.SpeechRecognition = FakeRecognition;
window.__teacherSays = async (text) => {
  const rec = window.__rec;
  if (!rec || !rec.active) {
    log(`dropped (mic off): ${text}`);
    return false;
  }
  const i = rec.results.length;
  rec.results.push(Object.assign([{ transcript: text.split(' ').slice(0, 3).join(' ') }], { isFinal: false }));
  rec.onresult({ resultIndex: i, results: rec.results });
  await new Promise((r) => setTimeout(r, 300));
  rec.results[i] = Object.assign([{ transcript: text }], { isFinal: true });
  window.__finalAt = performance.now();
  rec.onresult({ resultIndex: i, results: rec.results });
  return true;
};

// ---- Fake text-to-speech (browser path)
window.SpeechSynthesisUtterance = class {
  constructor(text) {
    this.text = text;
  }
};
Object.defineProperty(window, 'speechSynthesis', {
  configurable: true,
  value: {
    getVoices: () => [{ name: 'Fred', lang: 'en-US' }, { name: 'Google US English', lang: 'en-US' }],
    speak(u) {
      window.__ttsCalls.push({ text: u.text, at: performance.now(), voice: u.voice?.name });
      log(`tts:${u.text}`);
      setTimeout(() => u.onstart && u.onstart(), 10);
      this._t = setTimeout(() => u.onend && u.onend(), 400);
    },
    cancel() {
      clearTimeout(this._t);
    },
  },
});

// ---- Fake API
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = (o = {}) => ({ concepts: [], misconceptions: [], undefined_terms: [], question_response: { quality: 'none', quote: '' }, checked_understanding: { happened: false, quote: '' }, ...o });
const c1 = (quote, extra = {}) => ({ concept_id: 'c1', explained: true, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote, gap: '', ...extra });

const REPLIES = {
  reasoning: 'Why do they need the light for that, though?',
  board_clarify: 'What did you write under that arrow? I can’t read it.',
  board_question: 'So the arrow from the sun is the light going into the leaf?',
  error_check: 'Wait, so if the oxygen comes from the carbon dioxide, where does the water go?',
  clarify: 'What exactly happens to the light inside the leaf?',
  curiosity: 'So what makes the leaves green, then?',
  misconception: "Wait, but don't plants eat dirt? That's what I always thought.",
  react_to_answer: 'Oh, so the soil just gives water, and the leaves make the actual food.',
  explain_back: 'So basically, plants make their own sugar in the leaves using sunlight, water and air. Did I get that right?',
  apply: "So a plant in a dark closet couldn't make food, right?",
};

function streamText(text, signal) {
  const words = text.split(/(?<= )/);
  return new ReadableStream({
    async start(controller) {
      await sleep(window.__lat.replyFirstToken);
      for (const w of words) {
        if (signal?.aborted) break;
        controller.enqueue(new TextEncoder().encode(w));
        await sleep(window.__lat.replyChunk / 4);
      }
      controller.close();
    },
  });
}

const realFetch = window.fetch.bind(window);
window.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('/avatar/')) return realFetch(url, opts); // real static files (avatar art)
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : {};
  if (url === '/api/tts' && method === 'GET') return json({ provider: 'browser' });
  if (url === '/api/prepare') {
    window.__calls.prepare.push(body);
    await sleep(80);
    return json(body.mode === 'student' ? STUDY_EXT : EXTRACTION);
  }
  if (url === '/api/evaluate') {
    window.__calls.evaluate++;
    await sleep(window.__lat.evaluate);
    if (window.__failNextEvaluate) {
      window.__failNextEvaluate = false;
      return json({ error: 'simulated outage' }, 500);
    }
    const s = body.segment.toLowerCase();
    window.__calls.evalSegments.push(body.segment);
    if (s.startsWith('on the whiteboard')) return json(P({ concepts: [c1('light + water + CO2 -> sugar')] }));
    if (s.includes('light gives the energy')) {
      return json(P({ concepts: [c1('light gives the energy to build the sugar')], question_response: { quality: 'full', quote: 'light gives the energy to build the sugar' } }));
    }
    if (s.includes('oxygen comes from the carbon dioxide')) {
      return json(P({ concepts: [{ concept_id: 'c3', explained: true, correctness: 'incorrect', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'the oxygen comes from the carbon dioxide', gap: '' }] }));
    }
    const check = s.includes('does that make sense') ? { checked_understanding: { happened: true, quote: 'does that make sense' } } : {};
    if (s.includes('soil only gives water')) {
      return json(P({
        misconceptions: [{ misconception_id: 'm1', effect: 'corrected', quote: 'the soil only gives water and minerals' }],
        question_response: { quality: 'full', quote: 'the soil only gives water and minerals' },
        concepts: [c1('the food is sugar made in the leaves')],
        ...check,
      }));
    }
    if (s.includes('make their own food')) {
      return json(P({ concepts: [c1('plants make their own food', { used_example: true })], undefined_terms: s.includes('thylakoid') ? [{ term: 'thylakoid', quote: 'thylakoid' }] : [], ...check }));
    }
    return json(P(check));
  }
  if (url === '/api/reply') {
    window.__calls.reply.push(body.intent);
    window.__calls.replyBodies.push(body);
    window.__calls.personas.push(body.persona || '');
    return new Response(streamText(REPLIES[body.intent] || 'Okay, that makes sense.', opts.signal), { headers: { 'Content-Type': 'text/plain' } });
  }
  if (url === '/api/verify') {
    window.__calls.verify++;
    await sleep(window.__lat.verify);
    return json({ verdict: /sugar/.test(body.statement) && /sunlight|light/.test(body.statement) ? 'demonstrated' : 'partial', note: 'Says plants make sugar from light, water and air.' });
  }
  if (url === '/api/feedback') {
    window.__calls.feedback++;
    const checks = body.events.filter((e) => e.type === 'checked_understanding').map((e) => e.at);
    const metrics = computeSpeechMetrics(body.utterances, checks);
    const learning = learningSummary(body.initial, body.final);
    const evidence = buildEvidence({ initial: body.initial, final: body.final, events: body.events, metrics, learning });
    const three = fallbackThree(evidence);
    return json({ teaching: three, usedFallback: true, spoke: true, concepts: conceptSummary(body.final), evidence, metrics, learning });
  }
  if (url === '/api/coach') {
    // Stands in for the server route: the same deterministic coach the route
    // falls back to (Deep Agents can't run in this harness).
    window.__calls.coach.push(body);
    await sleep(300);
    if (window.__coachFail) return json({ error: 'simulated coach outage' }, 500);
    return json(await runLocalCoach(body, 'harness: deterministic coach'));
  }
  if (url === '/api/whiteboard') {
    window.__calls.whiteboard.push(body);
    await sleep(200);
    const first = window.__calls.whiteboard.length === 1;
    return json(cleanBoard({
      transcription: 'light + water + CO2 -> sugar',
      description: 'an arrow from a sun to a leaf',
      concept_ids: ['c1'],
      unclear: first ? [{ part: 'the label under the arrow', question: 'What did you write under the arrow?' }] : [],
      blank: false,
    }, { id: body.id, at: body.at, trigger: body.trigger, conceptIds: body.concepts.map((c) => c.id) }));
  }
  if (url === '/api/study-feedback') {
    window.__calls.studyFeedback.push(body);
    const ev = buildStudyEvidence(body.learner, body.boards);
    return json({ feedback: fallbackStudyFeedback(body.learner, ev, body.extraction, body.recurring), evidence: ev, candidates: reviewCandidates(body.learner, body.extraction, body.recurring) });
  }
  if (url === '/api/study-plan') {
    // Stands in for the server route: its deterministic planner (Deep Agents can't run here).
    window.__calls.studyPlan.push(body);
    await sleep(300);
    if (window.__studyPlanFail) return json({ error: 'simulated outage' }, 500);
    return json(await runFallbackPlanner(createPlannerState(body), 'harness: deterministic planner'));
  }
  return json({ error: `unknown ${url}` }, 404);
};

createRoot(document.getElementById('root')).render(<Home />);

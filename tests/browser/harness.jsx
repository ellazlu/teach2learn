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

window.__log = [];
const log = (x) => window.__log.push(x);
window.__lat = { evaluate: 1200, replyFirstToken: 400, replyChunk: 50, verify: 600 };
window.__calls = { evaluate: 0, reply: [], verify: 0, feedback: 0 };
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

window.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : {};
  if (url === '/api/tts' && method === 'GET') return json({ provider: 'browser' });
  if (url === '/api/prepare') {
    await sleep(80);
    return json(EXTRACTION);
  }
  if (url === '/api/evaluate') {
    window.__calls.evaluate++;
    await sleep(window.__lat.evaluate);
    if (window.__failNextEvaluate) {
      window.__failNextEvaluate = false;
      return json({ error: 'simulated outage' }, 500);
    }
    const s = body.segment.toLowerCase();
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
  return json({ error: `unknown ${url}` }, 404);
};

createRoot(document.getElementById('root')).render(<Home />);

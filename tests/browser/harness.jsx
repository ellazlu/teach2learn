// Browser harness: runs the REAL app UI and SessionEngine with simulated
// microphone (Web Speech API), text-to-speech, and API responses. The
// feedback API mock uses the real deterministic modules.
// Built and driven by tests/browser/run.mjs.

import { createRoot } from 'react-dom/client';
import Home from '../../app/page.js';
import { EXTRACTION } from '../fixtures.ts';
import { computeSpeechMetrics } from '../../lib/student/speech.ts';
import { learningSummary } from '../../lib/student/knowledge.ts';
import { buildEvidence, fallbackSuggestions } from '../../lib/student/evidence.ts';

window.__log = [];
const log = (x) => window.__log.push(x);

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
  const half = text.split(' ').slice(0, 3).join(' ');
  rec.results.push(Object.assign([{ transcript: half }], { isFinal: false }));
  rec.onresult({ resultIndex: i, results: rec.results });
  await new Promise((r) => setTimeout(r, 300));
  rec.results[i] = Object.assign([{ transcript: text }], { isFinal: true });
  rec.onresult({ resultIndex: i, results: rec.results });
  return true;
};

// ---- Fake text-to-speech
window.SpeechSynthesisUtterance = class {
  constructor(text) {
    this.text = text;
  }
};
Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
  speak(u) {
    log(`tts:${u.text}`);
    setTimeout(() => u.onstart && u.onstart(), 10);
    this._t = setTimeout(() => u.onend && u.onend(), 400);
  },
  cancel() {
    clearTimeout(this._t);
  },
} });

// ---- Fake API (scripted student evaluations)
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const P = (o = {}) => ({ concepts: [], misconceptions: [], undefined_terms: [], question_response: { quality: 'none', quote: '' }, checked_understanding: { happened: false, quote: '' }, ...o });
window.__calls = { evaluate: 0, speak: [], feedback: 0 };
window.__failNextEvaluate = false;

window.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  await new Promise((r) => setTimeout(r, 50));
  if (url === '/api/prepare') return json(EXTRACTION);
  if (url === '/api/evaluate') {
    window.__calls.evaluate++;
    if (window.__failNextEvaluate) {
      window.__failNextEvaluate = false;
      return json({ error: 'simulated outage' }, 500);
    }
    const s = body.segment.toLowerCase();
    if (s.includes('make their own food')) {
      return json(P({ concepts: [{ concept_id: 'c1', explained: true, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: true, quote: 'plants make their own food' }], undefined_terms: s.includes('thylakoid') ? [{ term: 'thylakoid', quote: 'thylakoid' }] : [] }));
    }
    if (s.includes('soil only gives water')) {
      return json(P({
        misconceptions: [{ misconception_id: 'm1', effect: 'corrected', quote: 'the soil only gives water and minerals' }],
        question_response: { quality: 'full', quote: 'the soil only gives water and minerals' },
        concepts: [{ concept_id: 'c1', explained: true, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'the food is sugar made in the leaves' }],
        checked_understanding: { happened: s.includes('make sense'), quote: 'does that make sense' },
      }));
    }
    return json(P());
  }
  if (url === '/api/speak') {
    window.__calls.speak.push(body.intent);
    const lines = { misconception: "Wait, but don't plants eat dirt?", show_understanding: 'Ohh! So plants cook their own sugar in the leaves?' };
    return json({ text: lines[body.intent] || 'What does that word mean?' });
  }
  if (url === '/api/feedback') {
    window.__calls.feedback++;
    const checks = body.events.filter((e) => e.type === 'checked_understanding').map((e) => e.at);
    const metrics = computeSpeechMetrics(body.utterances, checks);
    const learning = learningSummary(body.initial, body.final);
    const evidence = buildEvidence({ initial: body.initial, final: body.final, events: body.events, metrics, learning });
    return json({ summary: 'Harness summary.', suggestions: fallbackSuggestions(evidence), strengths: [], outside_knowledge: [], evidence, metrics, learning, usedFallback: true });
  }
  return json({ error: 'unknown' }, 404);
};

createRoot(document.getElementById('root')).render(<Home />);

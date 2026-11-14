// SessionEngine: the live-session orchestrator. It owns the authoritative
// student state and wires together segmentation -> evaluation -> deterministic
// update -> behavior -> action -> dialogue. Browser specifics (microphone,
// text-to-speech, fetch) are injected, so the whole loop runs in tests.
//
// Guarantees:
// - one evaluation in flight at a time; queued segments are merged
// - one student utterance at a time; no actions while speaking or finishing
// - the student's own voice is never fed back in as teacher speech
// - a failed API call leaves the model unchanged and the session continues

import type {
  BehaviorState,
  EvaluationProposal,
  Extraction,
  KnowledgeEvent,
  QuestionPlan,
  Segment,
  StudentAction,
  StudentModel,
} from './types.ts';
import { applyEvaluation, initStudentModel, modelForPrompt } from './knowledge.ts';
import { recordQuestion, seededRng } from './questions.ts';
import { behaviorFromEvents, decideAction, transition } from './behavior.ts';
import { addFinal, bufferToSegment, emptyBuffer, isLikelyEcho, mergeSegments, shouldFlush, type SegmentBuffer } from './segments.ts';
import { RUN_GAP_SEC } from './speech.ts';
import { getLevel } from '../levels.ts';

export interface EngineDeps {
  evaluate: (body: object) => Promise<EvaluationProposal>;
  speak: (body: object) => Promise<{ text: string }>;
  // Plays the student's line (and pauses the mic). Resolves with real timing.
  say: (text: string) => Promise<{ start: number; end: number }>;
  now: () => number; // seconds since session start
  onChange?: (snap: EngineSnapshot) => void;
  seed?: number;
}

export interface EngineSnapshot {
  ready: boolean;
  model: StudentModel | null;
  initialModel: StudentModel | null;
  behavior: BehaviorState;
  speaking: boolean;
  thinking: boolean;
  utterances: Segment[];
  lastError: string;
  lastAction: string;
}

const RECENT_EVALS = 2;

export class SessionEngine {
  private deps: EngineDeps;
  private levelId: StudentModel['levelId'];
  extraction: Extraction | null = null;
  model: StudentModel | null = null;
  initialModel: StudentModel | null = null;
  utterances: Segment[] = [];
  events: KnowledgeEvent[] = [];
  private buffer: SegmentBuffer = emptyBuffer();
  private queue: Segment[] = [];
  private segCounter = 0;
  private uttCounter = 0;
  private evaluating = false;
  private failedOnce = new Set<string>();
  private speaking = false;
  private speakingSince = Infinity;
  private phrasing = false;
  private finishing = false;
  private lastInterjectionAt = -Infinity;
  private understandingShown: string[] = [];
  private recentEvalConcepts: string[][] = [];
  private lastEvents: KnowledgeEvent[] = [];
  private rng: () => number;
  private lastError = '';
  private lastAction = '';
  private drainWaiters: (() => void)[] = [];
  questionsEnabled = true;

  constructor(levelId: StudentModel['levelId'], deps: EngineDeps) {
    this.levelId = levelId;
    this.deps = deps;
    this.rng = seededRng(deps.seed ?? Date.now());
  }

  // ---- inputs -------------------------------------------------------------------

  setExtraction(extraction: Extraction): void {
    if (this.model) return;
    this.extraction = extraction;
    this.model = initStudentModel(extraction, this.levelId);
    this.initialModel = structuredClone(this.model);
    this.emit();
    void this.pump();
  }

  // A final speech-recognition result. start/end are real event timestamps.
  onTeacherFinal(text: string, start: number, end: number): void {
    const t = text.trim();
    if (!t || this.finishing) return;
    const studentLines = this.utterances.filter((u) => u.speaker === 'student').map((u) => u.text);
    // Speech that started after the student began talking is the student's own
    // voice (or crosstalk); speech that started before it is the teacher's last words.
    if ((this.speaking && start >= this.speakingSince) || isLikelyEcho(t, studentLines.slice(-3))) {
      this.lastAction = 'ignored speech that sounded like the student';
      this.emit();
      return;
    }
    this.utterances.push({ id: `u${++this.uttCounter}`, speaker: 'teacher', text: t, start, end });
    this.buffer = addFinal(this.buffer, t, start, end);
    if (shouldFlush(this.buffer, end)) this.flush();
    this.emit();
    void this.pump();
  }

  tick(): void {
    if (shouldFlush(this.buffer, this.deps.now()) === 'pause') {
      this.flush();
      void this.pump();
    }
  }

  // ---- evaluation loop ------------------------------------------------------------

  private flush(): void {
    const seg = bufferToSegment(this.buffer, `s${++this.segCounter}`);
    this.buffer = emptyBuffer();
    if (seg) this.queue.push(seg);
  }

  private async pump(): Promise<void> {
    if (this.evaluating || !this.model || !this.queue.length) {
      if (!this.evaluating && !this.queue.length) this.resolveDrain();
      return;
    }
    this.evaluating = true;
    const batch = this.queue.splice(0);
    const seg = mergeSegments(batch)!;
    this.emit();
    try {
      const open = [...this.model.questions].reverse().find((q) => q.status === 'pending' || q.status === 'partially_answered');
      const earlier = this.utterances.filter((u) => u.speaker === 'teacher' && u.end <= seg.start).map((u) => u.text).join(' ').slice(-400);
      const proposal = await this.deps.evaluate({
        levelId: this.levelId,
        model: modelForPrompt(this.model),
        openQuestion: open?.text || '',
        earlierContext: earlier,
        segment: seg.text,
      });
      this.applyProposal(seg, proposal);
      this.lastError = '';
    } catch (err) {
      // Keep the previous state. Retry this segment once, then let it go.
      this.lastError = `Student evaluation failed: ${(err as Error).message}`;
      if (!this.failedOnce.has(seg.id) && !this.finishing) {
        this.failedOnce.add(seg.id);
        this.queue.unshift(seg);
      }
    } finally {
      this.evaluating = false;
      this.emit();
    }
    if (this.queue.length) void this.pump();
    else this.resolveDrain();
  }

  private applyProposal(seg: Segment, proposal: EvaluationProposal): void {
    if (!this.model) return;
    const { model, events } = applyEvaluation(this.model, seg, proposal);
    if (model === this.model) return;
    const now = this.deps.now();
    const proposed = behaviorFromEvents(model, events);
    const next = transition(model.behavior, proposed, { speaking: this.speaking, now, since: model.behaviorSince });
    if (next !== model.behavior) {
      model.behavior = next;
      model.behaviorSince = now;
    }
    this.model = model;
    this.events.push(...events);
    this.lastEvents = events;
    const touched = new Set<string>();
    for (const e of events) if ('conceptId' in e && e.conceptId) touched.add(e.conceptId);
    this.recentEvalConcepts = [...this.recentEvalConcepts, [...touched]].slice(-RECENT_EVALS);
    this.emit();
    void this.maybeAct();
  }

  // ---- acting -----------------------------------------------------------------------

  private teacherRunSec(now: number): number {
    const t = this.utterances;
    let i = t.length - 1;
    if (i < 0 || t[i].speaker !== 'teacher' || now - t[i].end >= RUN_GAP_SEC) return 0;
    let start = t[i].start;
    while (i > 0 && t[i - 1].speaker === 'teacher' && t[i].start - t[i - 1].end < RUN_GAP_SEC) {
      i--;
      start = t[i].start;
    }
    return now - start;
  }

  decide(): StudentAction {
    if (!this.model) return { kind: 'none', reason: 'not ready' };
    const now = this.deps.now();
    return decideAction({
      model: this.model,
      events: this.lastEvents,
      now,
      lastInterjectionAt: this.lastInterjectionAt,
      speaking: this.speaking || this.phrasing,
      finishing: this.finishing,
      teacherRunSec: this.teacherRunSec(now),
      recentConceptIds: [...new Set(this.recentEvalConcepts.flat())],
      latestConceptIds: this.recentEvalConcepts[this.recentEvalConcepts.length - 1] || [],
      understandingShown: this.understandingShown,
      rng: this.rng,
    });
  }

  private async maybeAct(): Promise<void> {
    const action = this.decide();
    this.lastAction = action.kind === 'none' ? action.reason : action.kind === 'question' ? `${action.type}: ${action.reason}` : action.reason;
    if (action.kind === 'none' || !this.model || !this.questionsEnabled) {
      this.emit();
      return;
    }
    this.phrasing = true;
    this.emit();
    let text = '';
    try {
      const res = await this.deps.speak(this.dialogueRequest(action));
      text = (res?.text || '').trim();
    } catch (err) {
      this.lastError = `Student couldn't phrase a question: ${(err as Error).message}`;
    }
    this.phrasing = false;
    if (!text || this.finishing || this.speaking || !this.model) {
      this.emit();
      return;
    }

    const now = this.deps.now();
    if (action.kind === 'question') this.model = recordQuestion(this.model, action, text, now);
    else this.understandingShown.push(action.conceptId);
    this.setSpeaking(true);
    try {
      const { start, end } = await this.deps.say(text);
      this.utterances.push({ id: `u${++this.uttCounter}`, speaker: 'student', text, start, end });
    } catch {
      this.utterances.push({ id: `u${++this.uttCounter}`, speaker: 'student', text, start: now, end: this.deps.now() });
    }
    this.lastInterjectionAt = this.deps.now();
    this.setSpeaking(false);
  }

  private setSpeaking(on: boolean): void {
    this.speaking = on;
    this.speakingSince = on ? this.deps.now() : Infinity;
    if (this.model) {
      const now = this.deps.now();
      const next = transition(this.model.behavior, this.model.behavior, { speaking: on, now, since: this.model.behaviorSince });
      if (next !== this.model.behavior) {
        this.model = { ...this.model, behavior: next, behaviorSince: now };
      }
    }
    this.emit();
  }

  private dialogueRequest(action: Exclude<StudentAction, { kind: 'none' }>) {
    const m = this.model!;
    const level = getLevel(this.levelId);
    const concept = m.concepts.find((c) => c.id === action.conceptId);
    const teacherText = this.utterances.filter((u) => u.speaker === 'teacher').map((u) => u.text).join(' ');
    const recentTeacher = teacherText.slice(-600);
    const plan = action.kind === 'question' ? (action as QuestionPlan) : null;
    const term =
      [...m.undefinedTerms].reverse().find((t) => recentTeacher.toLowerCase().includes(t.toLowerCase())) ||
      concept?.keyTerms.find((t) => recentTeacher.toLowerCase().includes(t.toLowerCase())) ||
      concept?.name ||
      'that';
    const related = concept?.prerequisites.map((p) => m.concepts.find((c) => c.id === p)).find((c) => c?.explained);
    const mis = plan?.misconceptionId ? m.misconceptions.find((x) => x.id === plan.misconceptionId) : null;
    const prev = plan?.followsQuestionId ? m.questions.find((q) => q.id === plan.followsQuestionId) : null;
    const lastQuote = concept?.evidence[concept.evidence.length - 1]?.quote || recentTeacher.slice(-200);

    const whatYouKnow = [
      ...m.concepts
        .filter((c) => c.mentioned)
        .map((c) => `${c.name}: ${c.mastery >= 70 ? 'you get this' : c.mastery >= 40 ? 'you sort of get this' : 'you do not get this yet'}`),
      ...m.misconceptions.filter((x) => x.status !== 'resolved').map((x) => `You currently believe: ${x.belief}`),
    ].join('\n') || 'Nothing yet.';

    return {
      levelId: level.id,
      intent: action.kind === 'show_understanding' ? 'show_understanding' : plan!.type,
      details: {
        term,
        conceptName: concept?.name || 'this',
        conceptDescription: concept?.description || '',
        relatedName: related?.name || '',
        belief: mis?.belief || '',
        previousQuestion: prev?.text || '',
        teacherWords: lastQuote,
        focusQuestion: plan?.focus?.question || '',
        focusQuote: plan?.focus?.quote || '',
      },
      // What a specific line should be about (checked in /api/speak).
      anchors: [plan?.focus?.question, plan?.focus?.quote, plan?.type === 'define_term' ? term : '', concept?.name, ...(concept?.keyTerms || []), mis?.belief, prev?.text, related?.name].filter(Boolean),
      teacherSaid: recentTeacher,
      whatYouKnow,
      alreadyAsked: this.utterances.filter((u) => u.speaker === 'student').map((u) => u.text),
    };
  }

  // ---- ending ----------------------------------------------------------------------

  private resolveDrain(): void {
    const w = this.drainWaiters.splice(0);
    w.forEach((f) => f());
  }

  // Flush remaining speech and wait (bounded) for the last evaluations.
  async finish(timeoutMs = 8000): Promise<void> {
    this.finishing = true;
    this.flush();
    if (this.model && (this.evaluating || this.queue.length)) {
      const drained = new Promise<void>((r) => this.drainWaiters.push(r));
      void this.pump();
      await Promise.race([drained, new Promise((r) => setTimeout(r, timeoutMs))]);
    }
    if (this.model) {
      this.model = { ...this.model, behavior: 'listening' };
    }
    this.emit();
  }

  snapshot(): EngineSnapshot {
    return {
      ready: !!this.model,
      model: this.model,
      initialModel: this.initialModel,
      behavior: this.model?.behavior || 'listening',
      speaking: this.speaking,
      thinking: this.evaluating || this.phrasing,
      utterances: this.utterances,
      lastError: this.lastError,
      lastAction: this.lastAction,
    };
  }

  private emit(): void {
    this.deps.onChange?.(this.snapshot());
  }
}

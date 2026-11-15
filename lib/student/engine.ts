// SessionEngine: the live-session orchestrator. It owns the authoritative
// student state. Browser specifics (mic, audio, fetch) are injected, so the
// whole loop runs in tests.
//
// Fast path (conversation):  teacher pauses -> decideTurn() (deterministic, instant)
//   -> one streamed reply call that sees exactly what the teacher just said
//   -> audio starts on the first sentence.
// Slow path (background, never blocks the conversation):
//   stable segments -> /evaluate -> applyEvaluation()     (knowledge model)
//   student demonstrations -> /verify -> applyVerification() (learning checks)
//
// Guarantees: one reply at a time; a reply is dropped if the teacher starts
// talking again before its audio begins (no talking over them); the student's
// own voice is never fed back in as teacher speech; failed calls leave state
// unchanged and the conversation continues.

import type {
  BehaviorState,
  Demonstration,
  EvaluationProposal,
  Extraction,
  KnowledgeEvent,
  Segment,
  StudentModel,
  TurnAction,
} from './types.ts';
import { applyEvaluation, applyVerification, initStudentModel, modelForPrompt } from './knowledge.ts';
import { recordQuestion, seededRng } from './questions.ts';
import { behaviorFromEvents, transition } from './behavior.ts';
import { addFinal, bufferToSegment, emptyBuffer, isLikelyEcho, mergeSegments, shouldFlush, type SegmentBuffer } from './segments.ts';
import { decideTurn, detectTeacherQuestion, END_OF_TURN_SEC } from './turns.ts';
import { takeSentences, flushSentences } from './sentences.ts';
import { specificity, fallbackLine } from './dialogue.ts';
import { knowledgeForPrompt, taughtAbout } from './persona.ts';
// Teach to Learn (mode 'student') only:
import type { BoardAnalysis, LearnerState } from '../learner/types.ts';
import { applyBoard, applyLearnerEvaluation, initLearner, recordProbe } from '../learner/tracker.ts';
import { decideLearnerTurn, scoreProbes } from '../learner/probes.ts';
import { boardSegmentText } from '../learner/whiteboard.ts';
import { learnerFallbackLine } from '../learner/lines.ts';

export interface Voice {
  begin(): Promise<void>; // pause the mic before the student speaks
  sentence(text: string): Promise<{ start: number; end: number }>; // queue + play one sentence
  end(): void; // resume the mic
  cancel(): void;
}

export interface EngineDeps {
  evaluate: (body: object) => Promise<EvaluationProposal>;
  verify: (body: object) => Promise<{ verdict: Demonstration['verdict']; note: string }>;
  reply: (body: object, onText: (delta: string) => void, signal: AbortSignal) => Promise<string>;
  voice: Voice;
  now: () => number; // wall-clock seconds since session start (timestamps)
  teachingNow?: () => number; // teaching seconds (excludes the student's speaking time)
  timeLimitSec: number;
  onChange?: (snap: EngineSnapshot) => void;
  seed?: number;
  persona?: string; // practice-challenge student profile, if any
  // Teach to Learn. Absent/'educator' leaves every Learn to Teach path unchanged.
  mode?: 'educator' | 'student';
  focusConceptIds?: string[]; // practice session: concepts to steer toward
  opening?: { text: string; conceptId: string | null } | null; // practice question the student opens with
}

export interface EngineSnapshot {
  ready: boolean;
  model: StudentModel | null;
  initialModel: StudentModel | null;
  behavior: BehaviorState;
  speaking: boolean;
  thinking: boolean;
  caption: string; // what the student is saying / last said
  utterances: Segment[];
  lastError: string;
  lastDecision: string;
  latencies: number[]; // ms from end of teacher speech to start of student audio
  learner: LearnerState | null; // Teach to Learn only
  boards: BoardAnalysis[]; // Teach to Learn only
}

const RECENT_EVALS = 2;
const MAX_SANE_LATENCY_MS = 20000;

type Act = Exclude<TurnAction, { kind: 'none' }>;
type Ask = Extract<TurnAction, { kind: 'ask' }>;

export class SessionEngine {
  private deps: EngineDeps;
  private levelId: StudentModel['levelId'];
  extraction: Extraction | null = null;
  model: StudentModel | null = null;
  initialModel: StudentModel | null = null;
  utterances: Segment[] = [];
  events: KnowledgeEvent[] = [];
  latencies: number[] = [];
  questionsEnabled = true;
  learner: LearnerState | null = null; // Teach to Learn only
  boards: BoardAnalysis[] = [];

  // background evaluation
  private buffer: SegmentBuffer = emptyBuffer();
  private queue: Segment[] = [];
  private segCounter = 0;
  private uttCounter = 0;
  private evaluating = false;
  private failedOnce = new Set<string>();
  private recentEvalConcepts: string[][] = [];
  private pendingVerifications = 0;
  private drainWaiters: (() => void)[] = [];

  // turn-taking
  private turnText = '';
  private lastFinalAt = -Infinity;
  private interimActive = false;
  private replying = false;
  private speaking = false;
  private speakingSince = Infinity;
  private abort: AbortController | null = null;
  private lastStudentAt = -Infinity;
  private lastStudentWasQuestion = false;
  private demoAttempts: Record<string, number> = {};
  private finishing = false;
  private caption = '';
  private rng: () => number;
  private lastError = '';
  private lastDecision = '';

  constructor(levelId: StudentModel['levelId'], deps: EngineDeps) {
    this.levelId = levelId;
    this.deps = deps;
    this.rng = seededRng(deps.seed ?? Date.now());
  }

  private get student(): boolean {
    return this.deps.mode === 'student';
  }

  private teachingNow(): number {
    return this.deps.teachingNow ? this.deps.teachingNow() : this.deps.now();
  }

  // ---- inputs ----------------------------------------------------------------------

  setExtraction(extraction: Extraction): void {
    if (this.model) return;
    this.extraction = extraction;
    this.model = initStudentModel(extraction, this.levelId);
    this.initialModel = structuredClone(this.model);
    if (this.student) this.learner = initLearner(extraction, this.deps.focusConceptIds || []);
    this.emit();
    void this.pump();
    if (this.student && this.deps.opening?.text) void this.sayOpening(this.deps.opening);
  }

  // The recognizer heard the teacher start (or keep) talking.
  onTeacherInterim(): void {
    if (this.speaking) return;
    this.interimActive = true;
    // Barge-in: a reply still being generated is dropped rather than talk over them.
    if (this.replying && this.abort) this.abort.abort();
  }

  onTeacherFinal(text: string, start: number, end: number): void {
    const t = text.trim();
    this.interimActive = false;
    if (!t || this.finishing) return;
    const studentLines = this.utterances.filter((u) => u.speaker === 'student').map((u) => u.text);
    // Speech that started after the student began talking is its own voice
    // (or crosstalk); speech that started before is the teacher's last words.
    if ((this.speaking && start >= this.speakingSince) || isLikelyEcho(t, studentLines.slice(-3))) {
      this.lastDecision = 'ignored speech that sounded like the student';
      this.emit();
      return;
    }
    this.utterances.push({ id: `u${++this.uttCounter}`, speaker: 'teacher', text: t, start, end });
    this.turnText = `${this.turnText} ${t}`.trim();
    this.lastFinalAt = end;
    this.buffer = addFinal(this.buffer, t, start, end);
    if (shouldFlush(this.buffer, end)) this.flush();
    this.emit();
    void this.pump();
  }

  // Called a few times per second by the host.
  tick(): void {
    const now = this.deps.now();
    if (shouldFlush(this.buffer, now) === 'pause') {
      this.flush();
      void this.pump();
    }
    if (this.turnText && !this.interimActive && !this.replying && !this.speaking && !this.finishing && now - this.lastFinalAt >= END_OF_TURN_SEC) {
      void this.endOfTurn();
    }
  }

  // ---- background evaluation ----------------------------------------------------------

  private flush(): void {
    const seg = bufferToSegment(this.buffer, `s${++this.segCounter}`);
    this.buffer = emptyBuffer();
    if (seg) this.queue.push(seg);
  }

  private async pump(): Promise<void> {
    if (this.evaluating || !this.model || !this.queue.length) {
      this.maybeResolveDrain();
      return;
    }
    this.evaluating = true;
    // Whiteboard readings are evaluated on their own (never merged with speech).
    const wb = this.queue.findIndex((x) => x.source === 'whiteboard');
    const take = wb === 0 ? 1 : wb > 0 ? wb : this.queue.length;
    const seg = mergeSegments(this.queue.splice(0, take))!;
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
      this.lastError = `Background evaluation failed (conversation unaffected): ${(err as Error).message}`;
      if (!this.failedOnce.has(seg.id) && !this.finishing) {
        this.failedOnce.add(seg.id);
        this.queue.unshift(seg);
      }
    } finally {
      this.evaluating = false;
      this.emit();
    }
    if (this.queue.length) void this.pump();
    else this.maybeResolveDrain();
  }

  private applyProposal(seg: Segment, proposal: EvaluationProposal): void {
    if (!this.model) return;
    const { model, events } = applyEvaluation(this.model, seg, proposal);
    if (model === this.model) return;
    this.model = model;
    if (this.student && this.learner) this.learner = applyLearnerEvaluation(this.learner, seg, proposal, model);
    this.recordEvents(events);
    const touched = new Set<string>();
    for (const e of events) if ('conceptId' in e && e.conceptId) touched.add(e.conceptId);
    this.recentEvalConcepts = [...this.recentEvalConcepts, [...touched]].slice(-RECENT_EVALS);
  }

  private recordEvents(events: KnowledgeEvent[]): void {
    if (!this.model) return;
    this.events.push(...events);
    const now = this.deps.now();
    const proposed = behaviorFromEvents(this.model, events);
    const next = transition(this.model.behavior, proposed, { speaking: this.speaking, now, since: this.model.behaviorSince });
    if (next !== this.model.behavior) this.model = { ...this.model, behavior: next, behaviorSince: now };
    this.emit();
  }

  // ---- the conversation ------------------------------------------------------------------

  private async endOfTurn(): Promise<void> {
    if (!this.model) {
      this.lastDecision = 'still reading the material';
      this.emit();
      return; // the turn text stays; it is answered once concepts are ready
    }
    if (this.buffer.parts.length) {
      this.flush();
      void this.pump(); // background evaluation of this turn; never awaited here
    }
    const turnText = this.turnText;
    const speechEndedAt = this.lastFinalAt;
    this.turnText = '';
    const action: TurnAction = !(this.questionsEnabled || detectTeacherQuestion(turnText))
      ? { kind: 'none', reason: 'questions are off' }
      : this.student && this.learner
        ? decideLearnerTurn({
            learner: this.learner,
            model: this.model,
            turnText,
            now: this.teachingNow(),
            lastStudentAt: this.lastStudentAt,
            lastStudentWasQuestion: this.lastStudentWasQuestion,
            recentConceptIds: [...new Set(this.recentEvalConcepts.flat())],
            rng: this.rng,
          })
        : decideTurn({
            model: this.model,
            turnText,
            now: this.teachingNow(),
            timeLimitSec: this.deps.timeLimitSec,
            lastStudentAt: this.lastStudentAt,
            lastStudentWasQuestion: this.lastStudentWasQuestion,
            recentConceptIds: [...new Set(this.recentEvalConcepts.flat())],
            demoAttempts: this.demoAttempts,
            rng: this.rng,
          });
    this.lastDecision = action.reason;
    if (action.kind === 'none') {
      this.emit();
      return;
    }
    await this.respond(action, turnText, speechEndedAt);
  }

  private async respond(action: Act, turnText: string, speechEndedAt: number): Promise<void> {
    this.replying = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.emit();

    const sentences: string[] = [];
    const plays: Promise<{ start: number; end: number }>[] = [];
    let buf = '';
    let started = false;
    let replaced = false;

    const startSpeaking = async () => {
      if (started) return;
      started = true;
      this.speaking = true;
      this.speakingSince = this.deps.now();
      this.setBehaviorSpeaking(true);
      await this.deps.voice.begin();
    };
    const queueSentence = (s: string) => {
      const p = this.deps.voice.sentence(s);
      if (!plays.length) {
        p.then(({ start }) => {
          const ms = Math.round((start - speechEndedAt) * 1000);
          if (ms >= 0 && ms < MAX_SANE_LATENCY_MS) this.latencies.push(ms);
          this.emit();
        }).catch(() => {});
      }
      plays.push(p);
      sentences.push(s);
      this.caption = sentences.join(' ');
      this.emit();
    };
    const onText = (delta: string) => {
      if (signal.aborted || replaced) return;
      buf += delta;
      const { sentences: done, rest } = takeSentences(buf);
      buf = rest;
      for (const s of done) {
        // Questions must be specific: checked on the first sentence, before any audio plays.
        if (!sentences.length && action.kind === 'ask' && !specificity(s, this.anchors(action)).ok) {
          replaced = true;
          this.abort?.abort();
          return;
        }
        void startSpeaking();
        queueSentence(s);
      }
    };

    try {
      await this.deps.reply(this.replyBody(action, turnText), onText, signal);
    } catch (err) {
      if (!signal.aborted) this.lastError = `Student reply failed: ${(err as Error).message}`;
    }

    if (replaced && action.kind === 'ask') {
      await startSpeaking();
      queueSentence(this.fallback(action));
    } else if (!signal.aborted) {
      const rest = flushSentences(buf);
      if (rest.length && !started && action.kind === 'ask' && !sentences.length && !specificity(rest.join(' '), this.anchors(action)).ok) {
        rest.splice(0, rest.length, this.fallback(action));
      }
      for (const s of rest) {
        await startSpeaking();
        queueSentence(s);
      }
    }

    if (!started) {
      // Dropped (teacher kept talking) or failed before any audio: nothing was said.
      this.replying = false;
      this.abort = null;
      this.turnText = `${turnText} ${this.turnText}`.trim();
      if (signal.aborted) this.lastDecision = 'held back: you kept talking';
      this.emit();
      return;
    }

    let start = this.deps.now();
    let end = start;
    try {
      const timings = await Promise.all(plays);
      start = timings[0].start;
      end = timings[timings.length - 1].end;
    } catch {
      end = this.deps.now();
    }
    this.deps.voice.end();
    const text = sentences.join(' ');
    this.utterances.push({ id: `u${++this.uttCounter}`, speaker: 'student', text, start, end });

    if (this.model && !this.finishing) {
      if (action.kind === 'ask') {
        this.model = recordQuestion(this.model, action.plan, text, start);
        if (this.student && this.learner) this.learner = recordProbe(this.learner, action.plan, this.model.questions[this.model.questions.length - 1].id, text, start);
      }
      if (action.kind === 'demonstrate') {
        this.demoAttempts[action.conceptId] = (this.demoAttempts[action.conceptId] || 0) + 1;
        void this.verify(action.conceptId, action.mode, text, start);
      }
      if (!this.student && action.kind === 'answer' && action.questionKind === 'content' && action.conceptIds[0]) {
        void this.verify(action.conceptIds[0], 'answer', text, start);
      }
    }
    this.lastStudentWasQuestion = action.kind === 'ask' || /\?\s*$/.test(text);
    this.lastStudentAt = this.teachingNow();
    this.speaking = false;
    this.speakingSince = Infinity;
    this.replying = false;
    this.abort = null;
    this.setBehaviorSpeaking(false);
  }

  // Grade a demonstration against the material, in the background.
  private async verify(conceptId: string, mode: Demonstration['mode'], text: string, at: number): Promise<void> {
    const c = this.model?.concepts.find((x) => x.id === conceptId);
    if (!c) return;
    this.pendingVerifications++;
    try {
      const r = await this.deps.verify({
        levelId: this.levelId,
        concept: { name: c.name, description: c.description, keyTerms: c.keyTerms },
        mode,
        statement: text,
        taught: taughtAbout(this.utterances, c),
      });
      if (this.model) {
        const { model, events } = applyVerification(this.model, conceptId, { at, mode, text, verdict: r.verdict, note: r.note || '' });
        this.model = model;
        this.recordEvents(events);
        if (r.verdict === 'demonstrated' && this.model && !this.speaking) {
          this.model = { ...this.model, behavior: 'understanding', behaviorSince: this.deps.now() };
        }
      }
    } catch (err) {
      this.lastError = `Couldn't check the student's explanation: ${(err as Error).message}`;
    } finally {
      this.pendingVerifications--;
      this.emit();
      this.maybeResolveDrain();
    }
  }

  private setBehaviorSpeaking(on: boolean): void {
    if (this.model) {
      const now = this.deps.now();
      const next = transition(this.model.behavior, this.model.behavior, { speaking: on, now, since: this.model.behaviorSince });
      if (next !== this.model.behavior) this.model = { ...this.model, behavior: next, behaviorSince: now };
    }
    this.emit();
  }

  // ---- reply request -----------------------------------------------------------------------

  private intentDetails(action: Ask) {
    const m = this.model!;
    const plan = action.plan;
    const concept = m.concepts.find((c) => c.id === plan.conceptId);
    const teacherText = this.utterances.filter((u) => u.speaker === 'teacher').map((u) => u.text).join(' ').slice(-600).toLowerCase();
    const term =
      [...m.undefinedTerms].reverse().find((t) => teacherText.includes(t.toLowerCase())) ||
      concept?.keyTerms.find((t) => teacherText.includes(t.toLowerCase())) ||
      concept?.name ||
      'that';
    const related = concept?.prerequisites.map((p) => m.concepts.find((c) => c.id === p)).find((c) => c?.explained);
    const mis = plan.misconceptionId ? m.misconceptions.find((x) => x.id === plan.misconceptionId) : null;
    const prev = plan.followsQuestionId ? m.questions.find((q) => q.id === plan.followsQuestionId) : null;
    return {
      term,
      conceptName: concept?.name || 'this',
      conceptDescription: concept?.description || '',
      relatedName: related?.name || '',
      belief: mis?.belief || '',
      previousQuestion: prev?.text || '',
      teacherWords: concept?.evidence[concept.evidence.length - 1]?.quote || '',
      focusQuestion: plan.focus?.question || '',
      focusQuote: plan.focus?.quote || '',
    };
  }

  private fallback(action: Ask): string {
    const d = this.intentDetails(action);
    return this.student ? learnerFallbackLine(action.plan.type, d) : fallbackLine(action.plan.type, d);
  }

  private anchors(action: Ask): string[] {
    const d = this.intentDetails(action);
    const concept = this.model!.concepts.find((c) => c.id === action.plan.conceptId);
    return [d.focusQuestion, d.focusQuote, d.term, d.conceptName, ...(concept?.keyTerms || []), d.belief, d.previousQuestion, d.relatedName].filter(Boolean);
  }

  private replyBody(action: Act, turnText: string) {
    const m = this.model!;
    const conceptId =
      action.kind === 'ask' ? action.plan.conceptId : action.kind === 'demonstrate' ? action.conceptId : action.kind === 'acknowledge' ? action.conceptId : action.conceptIds[0] || null;
    const concept = m.concepts.find((c) => c.id === conceptId) || null;
    const lastStudentLine = this.utterances.filter((u) => u.speaker === 'student').slice(-1)[0]?.text || '';
    const intent =
      action.kind === 'ask'
        ? action.plan.type
        : action.kind === 'demonstrate'
          ? action.mode
          : action.kind === 'answer'
            ? `answer_${action.questionKind}`
            : this.lastStudentWasQuestion
              ? 'react_to_answer'
              : 'acknowledge';
    return {
      levelId: this.levelId,
      intent,
      details: action.kind === 'ask' ? this.intentDetails(action) : { conceptName: concept?.name || '', conceptDescription: concept?.description || '' },
      knowledge: knowledgeForPrompt(m),
      taught: concept ? taughtAbout(this.utterances, concept) : '',
      conversation: this.utterances.slice(-10).map((u) => ({ speaker: u.speaker, text: u.text })),
      teacherJustSaid: turnText,
      previousQuestion: this.lastStudentWasQuestion ? lastStudentLine : '',
      alreadySaid: this.utterances.filter((u) => u.speaker === 'student').map((u) => u.text).slice(-8),
      ...(this.deps.persona ? { persona: this.deps.persona } : {}),
      ...(this.student
        ? {
            mode: 'student',
            outline: m.concepts.map((c) => c.name),
            board: this.learner?.board.latest ? { transcription: this.learner.board.latest.transcription, description: this.learner.board.latest.description } : null,
          }
        : {}),
    };
  }

  // ---- Teach to Learn: whiteboard + opening question ------------------------------------------

  // A whiteboard snapshot was read. Its content is evaluated like speech (so it
  // counts as evidence on the checklist); if the user explicitly shared it, the
  // student responds to it right away when nobody is talking.
  addBoard(a: BoardAnalysis): void {
    if (!this.student) return;
    this.boards.push(a);
    if (a.blank || !this.learner) {
      this.emit();
      return;
    }
    this.learner = applyBoard(this.learner, a);
    const text = boardSegmentText(a);
    if (text && !this.finishing) {
      this.queue.push({ id: a.id, speaker: 'teacher', text, start: a.at, end: a.at, source: 'whiteboard' });
      void this.pump();
    }
    this.emit();
    if (a.trigger === 'share') void this.respondToBoard(a);
  }

  private async respondToBoard(a: BoardAnalysis): Promise<void> {
    if (!this.model || !this.learner || this.replying || this.speaking || this.finishing || this.interimActive || this.turnText) return;
    const best = scoreProbes(this.learner, this.model, { recentConceptIds: a.conceptIds, latestConceptIds: a.conceptIds, rng: this.rng })
      .find((c) => c.type === 'board_clarify' || c.type === 'board_question');
    if (!best) return;
    this.lastDecision = `${best.type}: ${best.reason}`;
    await this.respond({ kind: 'ask', plan: { kind: 'question', ...best }, reason: 'they shared the whiteboard' }, '(They just shared their whiteboard.)', this.deps.now());
  }

  // Practice sessions open with the planned question, spoken as-is.
  private async sayOpening(o: { text: string; conceptId: string | null }): Promise<void> {
    if (!this.model || this.speaking || this.replying) return;
    const plan = { kind: 'question' as const, type: 'apply_new' as const, conceptId: o.conceptId, misconceptionId: null, followsQuestionId: null, focus: null, reason: 'practice question', score: 1 };
    this.replying = true;
    this.speaking = true;
    this.speakingSince = this.deps.now();
    this.caption = o.text;
    this.setBehaviorSpeaking(true);
    let start = this.deps.now();
    let end = start;
    try {
      await this.deps.voice.begin();
      const t = await this.deps.voice.sentence(o.text);
      start = t.start;
      end = t.end;
    } catch {
      end = this.deps.now();
    }
    this.deps.voice.end();
    this.utterances.push({ id: `u${++this.uttCounter}`, speaker: 'student', text: o.text, start, end });
    if (this.model && !this.finishing) {
      this.model = recordQuestion(this.model, plan, o.text, start);
      if (this.learner) this.learner = recordProbe(this.learner, plan, this.model.questions[this.model.questions.length - 1].id, o.text, start);
    }
    this.lastStudentWasQuestion = true;
    this.lastStudentAt = this.teachingNow();
    this.speaking = false;
    this.speakingSince = Infinity;
    this.replying = false;
    this.lastDecision = 'opened with the practice question';
    this.setBehaviorSpeaking(false);
  }

  // ---- ending ------------------------------------------------------------------------------

  private maybeResolveDrain(): void {
    if (this.evaluating || this.queue.length || this.pendingVerifications > 0) return;
    this.drainWaiters.splice(0).forEach((f) => f());
  }

  // Stop talking, flush remaining speech, and wait (bounded) for background work.
  async finish(timeoutMs = 8000): Promise<void> {
    this.finishing = true;
    this.abort?.abort();
    this.deps.voice.cancel();
    this.flush();
    if (this.model && (this.evaluating || this.queue.length || this.pendingVerifications > 0)) {
      const drained = new Promise<void>((r) => this.drainWaiters.push(r));
      void this.pump();
      await Promise.race([drained, new Promise((r) => setTimeout(r, timeoutMs))]);
    }
    if (this.model) this.model = { ...this.model, behavior: 'listening' };
    this.speaking = false;
    this.emit();
  }

  snapshot(): EngineSnapshot {
    return {
      ready: !!this.model,
      model: this.model,
      initialModel: this.initialModel,
      behavior: this.model?.behavior || 'listening',
      speaking: this.speaking,
      thinking: this.replying && !this.speaking,
      caption: this.caption,
      utterances: this.utterances,
      lastError: this.lastError,
      lastDecision: this.lastDecision,
      latencies: this.latencies,
      learner: this.learner,
      boards: this.boards,
    };
  }

  private emit(): void {
    this.deps.onChange?.(this.snapshot());
  }
}

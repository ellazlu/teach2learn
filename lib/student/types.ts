// Shared types for the simulated student. All state below is owned by
// deterministic code in lib/student/*. The LLM only *proposes* evaluations
// (EvaluationProposal) and writes dialogue; it never edits StudentModel directly.

export type LevelId = 'kindergarten' | 'middle' | 'high' | 'college' | 'expert';

export type BehaviorState = 'listening' | 'curious' | 'confused' | 'understanding' | 'challenging' | 'responding';

// ---- Concept extraction (LLM output, validated) ----------------------------

export interface ExtractedConcept {
  id: string;
  name: string;
  description: string;
  difficulty: number; // 1 (basic) .. 5 (advanced)
  prerequisites: string[]; // concept ids
  keyTerms: string[];
}

export interface ExtractedMisconception {
  id: string;
  conceptId: string;
  belief: string; // what the student wrongly believes, in plain words
  correction: string; // what a correct explanation must establish
}

export interface Extraction {
  topicTitle: string;
  overview: string;
  fromMaterial: boolean; // false when built from a topic name only
  concepts: ExtractedConcept[];
  misconceptions: ExtractedMisconception[];
}

// ---- Student knowledge model ------------------------------------------------

export interface Evidence {
  segmentId: string;
  at: number; // seconds into the session
  quote: string; // teacher's words that caused the change
  note: string; // short machine-written reason
  delta: number; // mastery change (0 if none)
}

// A specific thing the student is still stuck on, phrased as the question it
// would ask. Opened by an unclear/partial explanation, closed by a clear one.
export interface OpenGap {
  question: string;
  quote: string; // the teacher's words that left it open
  segmentId: string;
  at: number;
}

// Explained != understood. A concept is only "demonstrated" when the student
// explained it back or applied it correctly AND the teacher had taught it.
export type Verification = 'not_verified' | 'partial' | 'demonstrated';

export interface Demonstration {
  at: number;
  mode: 'explain_back' | 'apply' | 'answer';
  text: string; // what the student said
  verdict: 'demonstrated' | 'partial' | 'not_demonstrated';
  note: string; // what was right / missing, from the verifier
}

export interface ConceptState extends ExtractedConcept {
  initialMastery: number; // 0..100
  mastery: number; // 0..100
  confidence: number; // 0..1, how sure the simulation is about `mastery`
  mentioned: boolean;
  explained: boolean; // explained at least once correctly enough to count
  explainCount: number;
  evidence: Evidence[];
  openGaps: OpenGap[]; // newest last; may be missing on sessions saved before this field existed
  verification: Verification;
  demonstrations: Demonstration[];
}

export type MisconceptionStatus = 'active' | 'partially_addressed' | 'resolved';

export interface MisconceptionChange {
  segmentId: string;
  at: number;
  from: MisconceptionStatus;
  to: MisconceptionStatus;
  quote: string;
}

export interface MisconceptionState extends ExtractedMisconception {
  status: MisconceptionStatus;
  expressed: boolean; // has the student voiced it yet?
  history: MisconceptionChange[];
}

export type QuestionType =
  | 'define_term'
  | 'clarify'
  | 'example'
  | 'relate'
  | 'prerequisite'
  | 'misconception'
  | 'follow_up'
  | 'challenge'
  | 'check_in'
  | 'curiosity';

export type QuestionStatus = 'pending' | 'answered' | 'partially_answered' | 'unanswered';

export interface StudentQuestion {
  id: string;
  at: number;
  conceptId: string | null;
  misconceptionId: string | null;
  type: QuestionType;
  text: string;
  status: QuestionStatus;
  segmentsSinceAsked: number;
  answerQuote: string;
}

export interface StudentModel {
  version: 1;
  levelId: LevelId;
  concepts: ConceptState[]; // in teaching order
  misconceptions: MisconceptionState[];
  behavior: BehaviorState;
  behaviorSince: number; // seconds
  questions: StudentQuestion[];
  processedSegmentIds: string[];
  undefinedTerms: string[]; // jargon the student heard without a definition
}

// ---- Transcript ---------------------------------------------------------------

export type Speaker = 'teacher' | 'student';

// A stable (final) piece of speech with real client-side timestamps.
export interface Segment {
  id: string;
  speaker: Speaker;
  text: string;
  start: number; // seconds since session start (wall clock)
  end: number;
}

// ---- Evaluation (LLM proposal for one teacher segment) -------------------------

export type Correctness = 'correct' | 'partially_correct' | 'incorrect';
export type Clarity = 'clear' | 'somewhat_clear' | 'unclear';
export type LevelFit = 'appropriate' | 'too_advanced' | 'too_simple';

export interface ConceptProposal {
  concept_id: string;
  explained: boolean; // false = only mentioned
  correctness: Correctness;
  clarity: Clarity;
  level_fit: LevelFit;
  used_example: boolean;
  quote: string;
  gap: string; // the specific question a learner would still have, or ''
}

export interface MisconceptionProposal {
  misconception_id: string;
  effect: 'corrected' | 'partially_corrected' | 'reinforced';
  quote: string;
}

export interface EvaluationProposal {
  concepts: ConceptProposal[];
  misconceptions: MisconceptionProposal[];
  undefined_terms: { term: string; quote: string }[];
  question_response: { quality: 'full' | 'partial' | 'none'; quote: string };
  checked_understanding: { happened: boolean; quote: string };
}

// ---- Events (what changed, for the UI, behavior engine and feedback) ---------

export type KnowledgeEvent =
  | { type: 'mastery_change'; segmentId: string; at: number; conceptId: string; from: number; to: number; quote: string; reason: string }
  | { type: 'mentioned_only'; segmentId: string; at: number; conceptId: string; quote: string }
  | { type: 'incorrect_explanation'; segmentId: string; at: number; conceptId: string; quote: string }
  | { type: 'unclear_explanation'; segmentId: string; at: number; conceptId: string; quote: string; levelFit: LevelFit; gap: string }
  | { type: 'misconception_change'; segmentId: string; at: number; misconceptionId: string; from: MisconceptionStatus; to: MisconceptionStatus; quote: string }
  | { type: 'undefined_term'; segmentId: string; at: number; term: string; quote: string }
  | { type: 'question_status'; segmentId: string; at: number; questionId: string; status: QuestionStatus; quote: string }
  | { type: 'checked_understanding'; segmentId: string; at: number; quote: string }
  | { type: 'used_example'; segmentId: string; at: number; conceptId: string; quote: string }
  | { type: 'rejected_proposal'; segmentId: string; at: number; detail: string }
  | { type: 'demonstration'; segmentId: string; at: number; conceptId: string; mode: Demonstration['mode']; verdict: Demonstration['verdict']; text: string; note: string; status: Verification };

// ---- Actions the student can take -----------------------------------------------

export interface QuestionPlan {
  kind: 'question';
  type: QuestionType;
  conceptId: string | null;
  misconceptionId: string | null;
  followsQuestionId: string | null;
  focus: { question: string; quote: string } | null; // the specific sticking point, when known
  reason: string;
  score: number;
}

export type StudentAction =
  | { kind: 'none'; reason: string }
  | QuestionPlan
  | { kind: 'show_understanding'; conceptId: string; reason: string };

// ---- Turn-taking -----------------------------------------------------------------

export type TeacherQuestionKind = 'check' | 'content' | null;

export type TurnAction =
  | { kind: 'none'; reason: string }
  | { kind: 'answer'; questionKind: 'check' | 'content'; conceptIds: string[]; reason: string }
  | { kind: 'ask'; plan: QuestionPlan; reason: string }
  | { kind: 'acknowledge'; conceptId: string | null; reason: string }
  | { kind: 'demonstrate'; conceptId: string; mode: 'explain_back' | 'apply'; reason: string };

// ---- Speech metrics ------------------------------------------------------------

export interface SpeechMetrics {
  teacherWords: number;
  teacherSpeakingSec: number;
  studentSpeakingSec: number;
  wordsPerMinute: number | null; // null when there isn't enough speech to measure
  longPauses: { at: number; seconds: number }[];
  fillerCount: number;
  fillers: Record<string, number>;
  longestRun: { start: number; end: number; seconds: number; words: number } | null;
  runsOver90s: { start: number; seconds: number }[];
  responseLatencies: { questionAt: number; seconds: number }[];
  checksForUnderstanding: number[]; // timestamps
  teacherShare: number | null; // 0..1 of measured speaking time
}

// L2T Daily server logic: signed attempts, server-side recording of what the
// AI actually evaluated during the session, server-side scoring, best attempt
// per user per day, and the shared leaderboard.
//
// Anti-cheat: the client never sends a score. The score is rebuilt on the
// server from (1) evaluations, questions and verifications the server itself
// produced and recorded during the attempt, and (2) the client's transcript,
// keeping only lines that match what the server evaluated or what the student
// actually said. Attempts are HMAC-signed, single-use, time-checked and
// rate-limited; user ids are signed so nobody can post under someone else's id.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { EvaluationProposal, QuestionType, Segment } from '../student/types.ts';
import { applyEvaluation, applyVerification, initStudentModel, learningSummary } from '../student/knowledge.ts';
import { recordQuestion } from '../student/questions.ts';
import { computeSpeechMetrics } from '../student/speech.ts';
import { buildEvidence } from '../student/evidence.ts';
import { quoteAppearsIn } from '../verify.ts';
import { CATEGORIES, scoreSession } from '../coach/rubric.ts';
import { challengeFor, dayKey, nextResetAt, publicChallenge } from './schedule.ts';
import type { DailyStore } from './store.ts';

export interface DailyDeps {
  store: DailyStore;
  secret: string;
  now: () => number;
}

export const LIMITS = {
  startsPerDay: 15,
  eventsPerAttempt: 80,
  minSessionSec: 45,
  graceAfterLimitSec: 15 * 60, // time to finish + get feedback after the timer
  graceAfterResetSec: 15 * 60, // an attempt started before midnight UTC may still be submitted briefly after
};
const TTL = 3 * 86400;

export class DailyError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---- Signing --------------------------------------------------------------------------

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const mac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export interface AttemptClaims { d: string; u: string; a: string; t: number }

export function signAttempt(secret: string, c: AttemptClaims): string {
  const body = b64(JSON.stringify(c));
  return `${body}.${mac(secret, `attempt:${body}`)}`;
}

export function verifyAttempt(secret: string, token: unknown): AttemptClaims {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || !same(sig, mac(secret, `attempt:${body}`))) throw new DailyError('Invalid attempt.', 403);
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof c.d !== 'string' || typeof c.u !== 'string' || typeof c.a !== 'string' || typeof c.t !== 'number') throw new Error();
    return c;
  } catch {
    throw new DailyError('Invalid attempt.', 403);
  }
}

export const userSig = (secret: string, userId: string) => mac(secret, `user:${userId}`);

export function cleanUsername(raw: unknown): string {
  const s = String(raw ?? '').normalize('NFKC').replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  if (s.length < 2) throw new DailyError('Choose a username of 2-20 letters or numbers.');
  return s;
}

// ---- Start ------------------------------------------------------------------------------

export async function startAttempt(deps: DailyDeps, input: { username: unknown; userId?: unknown; userSig?: unknown }) {
  const username = cleanUsername(input.username);
  let userId = typeof input.userId === 'string' && /^[a-f0-9]{20}$/.test(input.userId) ? input.userId : '';
  if (!userId || !same(String(input.userSig || ''), userSig(deps.secret, userId))) userId = randomBytes(10).toString('hex');
  const now = deps.now();
  const day = dayKey(now);
  const starts = await deps.store.incr(`l2t:${day}:starts:${userId}`, TTL);
  if (starts > LIMITS.startsPerDay) throw new DailyError(`That's the limit of ${LIMITS.startsPerDay} attempts for today. Try again tomorrow.`, 429);
  const attemptId = randomBytes(9).toString('hex');
  await deps.store.set(`l2t:att:${attemptId}`, JSON.stringify({ day, userId, username, t: now }), TTL);
  return {
    token: signAttempt(deps.secret, { d: day, u: userId, a: attemptId, t: now }),
    userId,
    userSig: userSig(deps.secret, userId),
    username,
    challenge: publicChallenge(day),
  };
}

// ---- Recording during the session ----------------------------------------------------------

export type DailyEvent =
  | { k: 'eval'; at: number; segment: string; proposal: EvaluationProposal }
  | { k: 'reply'; at: number; text: string; intent: string; conceptId: string | null; misconceptionId: string | null }
  | { k: 'verify'; at: number; conceptId: string; mode: 'explain_back' | 'apply' | 'answer'; verdict: 'demonstrated' | 'partial' | 'not_demonstrated' };

function liveAttempt(deps: DailyDeps, token: unknown): AttemptClaims {
  const c = verifyAttempt(deps.secret, token);
  const ch = challengeFor(c.d);
  if ((deps.now() - c.t) / 1000 > ch.timeLimitSec + LIMITS.graceAfterLimitSec) throw new DailyError('This attempt has expired.', 410);
  return c;
}

export async function recordEvent(deps: DailyDeps, token: unknown, e: Omit<DailyEvent, 'at'> & Record<string, any>): Promise<void> {
  const c = liveAttempt(deps, token);
  if (await deps.store.get(`l2t:sub:${c.a}`)) return; // already submitted: ignore
  const n = await deps.store.incr(`l2t:evn:${c.a}`, TTL);
  if (n > LIMITS.eventsPerAttempt) return;
  const at = Math.round((deps.now() - c.t) / 100) / 10;
  await deps.store.rpush(`l2t:ev:${c.a}`, JSON.stringify({ ...e, at }), TTL);
}

// Map the client's concept/misconception names to the challenge's fixed ids.
export function conceptIdFor(day: string, name: unknown): string | null {
  const n = String(name || '').trim().toLowerCase();
  return challengeFor(day).extraction.concepts.find((c) => c.name.toLowerCase() === n)?.id ?? null;
}
export function misconceptionIdFor(day: string, belief: unknown): string | null {
  const b = String(belief || '').trim().toLowerCase();
  return challengeFor(day).extraction.misconceptions.find((m) => m.belief.toLowerCase() === b)?.id ?? null;
}

const QUESTION_TYPES: QuestionType[] = ['define_term', 'clarify', 'example', 'relate', 'prerequisite', 'misconception', 'follow_up', 'challenge', 'check_in', 'curiosity'];
export const isQuestionIntent = (intent: string) => QUESTION_TYPES.includes(intent as QuestionType);

// ---- Scoring on the server -------------------------------------------------------------------

export function rebuildAndScore(day: string, events: DailyEvent[], clientUtterances: unknown, elapsedSec: number) {
  const ch = challengeFor(day);
  let model = initStudentModel(ch.extraction, ch.levelId);
  const initial = structuredClone(model);
  const kevents: any[] = [];
  const sorted = [...events].sort((a, b) => a.at - b.at);
  sorted.forEach((e, i) => {
    if (e.k === 'eval') {
      const seg: Segment = { id: `s${i}`, speaker: 'teacher', text: String(e.segment), start: e.at, end: e.at };
      const r = applyEvaluation(model, seg, e.proposal);
      model = r.model;
      kevents.push(...r.events);
    } else if (e.k === 'reply' && isQuestionIntent(e.intent)) {
      model = recordQuestion(model, { kind: 'question', type: e.intent as QuestionType, conceptId: e.conceptId, misconceptionId: e.misconceptionId, followsQuestionId: null, focus: null, reason: '', score: 0 }, e.text, e.at);
    } else if (e.k === 'verify' && e.conceptId) {
      const r = applyVerification(model, e.conceptId, { at: e.at, mode: e.mode, text: '', verdict: e.verdict, note: '' });
      model = r.model;
      kevents.push(...r.events);
    }
  });

  // Keep only transcript lines the server can vouch for.
  const evaluated = sorted.filter((e) => e.k === 'eval').map((e: any) => e.segment).join(' ');
  const said = sorted.filter((e) => e.k === 'reply').map((e: any) => e.text);
  const raw = Array.isArray(clientUtterances) ? clientUtterances.slice(0, 400) : [];
  let dropped = 0;
  const utterances: Segment[] = [];
  for (const u of raw) {
    const text = String(u?.text || '').slice(0, 2000);
    const start = Math.max(0, Math.min(elapsedSec, Number(u?.start) || 0));
    const end = Math.max(start, Math.min(elapsedSec, Number(u?.end) || start));
    const speaker = u?.speaker === 'student' ? 'student' : 'teacher';
    const ok = speaker === 'teacher' ? quoteAppearsIn(text, evaluated, 0.8) : said.some((s) => quoteAppearsIn(text, s, 0.8) || quoteAppearsIn(s, text, 0.8));
    if (!text.trim() || !ok) {
      dropped += 1;
      continue;
    }
    utterances.push({ id: `u${utterances.length}`, speaker, text, start, end });
  }
  utterances.sort((a, b) => a.start - b.start);
  const checks = kevents.filter((e) => e.type === 'checked_understanding').map((e) => e.at);
  const metrics = computeSpeechMetrics(utterances, checks);
  const evidence = buildEvidence({ initial, final: model, events: kevents, metrics, learning: learningSummary(initial, model) });
  const scores = scoreSession({ levelId: ch.levelId, utterances, events: kevents, metrics, evidence, finalModel: model });
  return { scores, dropped, kept: utterances.length };
}

// ---- Submit + leaderboard ------------------------------------------------------------------------

export interface BoardEntry { userId: string; username: string; score: number; at: number; attemptId: string; breakdown: Record<string, number | null> }

export async function submitAttempt(deps: DailyDeps, input: { token: unknown; userId: unknown; userSig: unknown; utterances: unknown }) {
  const c = verifyAttempt(deps.secret, input.token);
  if (c.u !== input.userId || !same(String(input.userSig || ''), userSig(deps.secret, c.u))) throw new DailyError('This attempt belongs to a different user.', 403);
  const now = deps.now();
  const ch = challengeFor(c.d);
  const elapsed = (now - c.t) / 1000;
  const today = dayKey(now);
  const late = c.d !== today && now - nextResetAt(c.t) > LIMITS.graceAfterResetSec * 1000;
  if (late) throw new DailyError("This attempt was for an earlier day's challenge.", 410);
  if (elapsed > ch.timeLimitSec + LIMITS.graceAfterLimitSec) throw new DailyError('This attempt has expired.', 410);
  if (!(await deps.store.setNX(`l2t:sub:${c.a}`, '1', TTL))) throw new DailyError('This attempt was already submitted.', 409);
  const meta = JSON.parse((await deps.store.get(`l2t:att:${c.a}`)) || '{}');
  const username = cleanUsername(meta.username || 'Player');

  const events = (await deps.store.lrange(`l2t:ev:${c.a}`)).map((x) => JSON.parse(x) as DailyEvent);
  const { scores, dropped } = rebuildAndScore(c.d, events, input.utterances, elapsed);
  const reasons: string[] = [];
  if (elapsed < LIMITS.minSessionSec) reasons.push(`Sessions shorter than ${LIMITS.minSessionSec} seconds don't count.`);
  if (scores.overall === null) reasons.push('Not enough teaching to score.');
  const eligible = reasons.length === 0;
  const breakdown = Object.fromEntries(CATEGORIES.map((k) => [k, scores[k].score]));
  const score = scores.overall;
  await deps.store.set(`l2t:res:${c.a}`, JSON.stringify({ score, breakdown, eligible, at: now }), TTL);

  let best: BoardEntry | null = null;
  const boardKey = `l2t:${c.d}:board`;
  const cur = (await deps.store.hgetall(boardKey))[c.u];
  const prev: BoardEntry | null = cur ? JSON.parse(cur) : null;
  best = prev;
  if (eligible && score !== null && (!prev || score > prev.score)) {
    best = { userId: c.u, username, score, at: now, attemptId: c.a, breakdown };
    await deps.store.hset(boardKey, c.u, JSON.stringify(best), 7 * 86400);
  }
  const board = await leaderboard(deps, c.d, c.u);
  return { day: c.d, score, breakdown, eligible, reasons, droppedLines: dropped, best: best ? { score: best.score, at: best.at } : null, rank: board.me?.rank ?? null, total: board.total };
}

export async function leaderboard(deps: DailyDeps, day: string, userId?: string, limit = 50) {
  const all = Object.values(await deps.store.hgetall(`l2t:${day}:board`))
    .map((x) => { try { return JSON.parse(x) as BoardEntry; } catch { return null; } })
    .filter((x): x is BoardEntry => !!x && typeof x.score === 'number')
    .sort((a, b) => b.score - a.score || a.at - b.at);
  const ranked = all.map((e, i) => ({ rank: i + 1, username: e.username, score: e.score, at: e.at, me: e.userId === userId }));
  const me = ranked.find((r) => r.me) || null;
  return { day, total: ranked.length, entries: ranked.slice(0, limit), me };
}

export function dailySecret(): string {
  const env = (globalThis as any).process?.env || {};
  if (env.DAILY_SECRET) return env.DAILY_SECRET;
  if (env.ANTHROPIC_API_KEY) return createHmac('sha256', 'l2t-daily').update(env.ANTHROPIC_API_KEY).digest('hex');
  if (env.NODE_ENV !== 'production') return 'l2t-daily-dev-secret';
  throw new DailyError('L2T Daily is not configured (set DAILY_SECRET).', 503);
}

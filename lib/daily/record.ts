// Called by the live-session routes when a request belongs to an L2T Daily
// attempt (body.daily = attempt token). Records what the server itself produced
// so the final score can be rebuilt server-side. Never blocks or breaks the
// conversation: failures are logged and ignored.

import { conceptIdFor, dailySecret, isQuestionIntent, misconceptionIdFor, recordEvent, verifyAttempt } from './service.ts';
import { getStore } from './store.ts';

const deps = () => ({ store: getStore(), secret: dailySecret(), now: Date.now });

async function safe(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e: any) {
    console.warn('[daily] event not recorded:', e?.message || e);
  }
}

export const recordEval = (token: unknown, segment: string, proposal: unknown) =>
  safe(() => recordEvent(deps(), token, { k: 'eval', segment: String(segment).slice(0, 4000), proposal } as any));

export const recordVerify = (token: unknown, conceptName: unknown, mode: unknown, verdict: unknown) =>
  safe(async () => {
    const d = deps();
    const day = verifyAttempt(d.secret, token).d;
    const conceptId = conceptIdFor(day, conceptName);
    if (!conceptId || !['explain_back', 'apply', 'answer'].includes(String(mode))) return;
    await recordEvent(d, token, { k: 'verify', conceptId, mode, verdict } as any);
  });

export const recordReply = (token: unknown, intent: unknown, text: string, details: any) =>
  safe(async () => {
    const d = deps();
    const day = verifyAttempt(d.secret, token).d;
    const i = String(intent || '');
    await recordEvent(d, token, {
      k: 'reply',
      text: text.slice(0, 600),
      intent: i,
      conceptId: isQuestionIntent(i) ? conceptIdFor(day, details?.conceptName) : null,
      misconceptionId: i === 'misconception' ? misconceptionIdFor(day, details?.belief) : null,
    } as any);
  });

import { NextResponse } from 'next/server';
import { DailyError, dailySecret, submitAttempt } from '../../../../lib/daily/service.ts';
import { getStore } from '../../../../lib/daily/store.ts';

// L2T Daily: finish an attempt. The score is computed here from what the
// server recorded during the session; anything the client says about its own
// score is ignored.
export const runtime = 'nodejs';

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const out = await submitAttempt({ store: getStore(), secret: dailySecret(), now: Date.now }, { token: body.token, userId: body.userId, userSig: body.userSig, utterances: body.utterances });
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof DailyError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error('[daily] submit failed', e);
    return NextResponse.json({ error: "Couldn't score this attempt." }, { status: 500 });
  }
}

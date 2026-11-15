import { NextResponse } from 'next/server';
import { DailyError, dailySecret, startAttempt } from '../../../../lib/daily/service.ts';
import { getStore } from '../../../../lib/daily/store.ts';

// L2T Daily: begin an attempt. Returns a signed, single-use attempt token that
// the live-session routes use to record what happens.
export const runtime = 'nodejs';

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const out = await startAttempt({ store: getStore(), secret: dailySecret(), now: Date.now }, body || {});
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof DailyError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error('[daily] start failed', e);
    return NextResponse.json({ error: "Couldn't start today's challenge." }, { status: 500 });
  }
}

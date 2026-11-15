import { NextResponse } from 'next/server';
import { dayKey, nextResetAt, publicChallenge } from '../../../lib/daily/schedule.ts';
import { DailyError, dailySecret, leaderboard } from '../../../lib/daily/service.ts';
import { getStore } from '../../../lib/daily/store.ts';

// L2T Daily: today's challenge (same for everyone) and the shared leaderboard.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const now = Date.now();
    const day = dayKey(now);
    const userId = new URL(req.url).searchParams.get('userId') || undefined;
    const store = getStore();
    const board = await leaderboard({ store, secret: dailySecret(), now: () => now }, day, userId);
    return NextResponse.json({ challenge: publicChallenge(day), leaderboard: board, now, nextResetAt: nextResetAt(now), storage: store.kind }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const status = e instanceof DailyError ? e.status : 500;
    return NextResponse.json({ error: e instanceof DailyError ? e.message : 'The leaderboard is unavailable right now.' }, { status });
  }
}

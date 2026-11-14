import { NextResponse } from 'next/server';
import { MODELS } from '../../../lib/claude.js';
import { runCoach } from '../../../lib/coach/agent.ts';

// Post-session coach (Deep Agents, with a deterministic fallback). Called by the
// client in the background after feedback is shown; never part of the live loop.
export const runtime = 'nodejs';
export const maxDuration = 120;

const LEVELS = ['kindergarten', 'middle', 'high', 'college', 'expert'];

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const session = body?.session;
  if (!session || typeof session.id !== 'string' || !Array.isArray(session.utterances) || !LEVELS.includes(session.levelId)) {
    return NextResponse.json({ error: 'A completed session (id, levelId, utterances) is required.' }, { status: 400 });
  }
  const history = body.history && Array.isArray(body.history.sessions) ? body.history : null;
  const activeChallenge = body.activeChallenge && Array.isArray(body.activeChallenge.criteria) ? body.activeChallenge : null;
  try {
    const result = await runCoach(
      { session: { events: [], evidence: [], metrics: null, finalModel: null, ...session }, history, activeChallenge, coachNotes: String(body.coachNotes || '').slice(0, 300) },
      { apiKey: process.env.ANTHROPIC_API_KEY, model: MODELS.smart },
    );
    return NextResponse.json(result);
  } catch (e) {
    console.error('[coach] failed', e);
    return NextResponse.json({ error: 'The coach could not review this session.' }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { MODELS } from '../../../lib/claude.js';
import { runStudyPlanner } from '../../../lib/study/planner.ts';

// Teach to Learn: knowledge-gap analysis + practice planning (Deep Agents, with
// a deterministic fallback). Called in the background after feedback; never
// part of the live conversation. Separate from the Learn to Teach coach.
export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const session = body?.session;
  if (!session || session.version !== 'study1' || !session.learner?.concepts || !Array.isArray(session.utterances)) {
    return NextResponse.json({ error: 'A completed Teach to Learn session is required.' }, { status: 400 });
  }
  const history = body.history && Array.isArray(body.history.sessions) ? body.history : null;
  try {
    const plan = await runStudyPlanner(
      { session: { boards: [], ...session }, history, material: String(body.material || '').slice(0, 20000), note: String(body.note || '').slice(0, 300) },
      { apiKey: process.env.ANTHROPIC_API_KEY, model: MODELS.smart },
    );
    return NextResponse.json(plan);
  } catch (e) {
    console.error('[study] failed', e);
    return NextResponse.json({ error: 'The study planner could not analyze this session.' }, { status: 500 });
  }
}

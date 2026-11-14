import { NextResponse } from 'next/server';
import { callTool, MODELS } from '../../../lib/claude.js';
import { getLevel } from '../../../lib/levels.js';
import { notesSystem, notesUserText, NOTES_TOOL } from '../../../lib/prompts.js';
import { serverError } from '../../../lib/http.js';

export const maxDuration = 30;

export async function POST(req) {
  try {
    const { levelId, newSpeech, contextTail, recentNotes } = await req.json();
    if (!newSpeech?.trim()) return NextResponse.json({ notes: [] });

    const level = getLevel(levelId);
    const out = await callTool({
      model: MODELS.fast,
      system: notesSystem(level),
      content: [{ type: 'text', text: notesUserText({ contextTail, recentNotes, newSpeech }) }],
      tool: NOTES_TOOL,
      maxTokens: 1000,
    });

    const notes = (out.notes || [])
      .filter((n) => n?.text?.trim())
      .map((n) => ({ kind: n.kind === 'lost' ? 'lost' : 'note', text: n.text.trim(), verbatim: !!n.verbatim }));
    return NextResponse.json({ notes });
  } catch (err) {
    return serverError(err);
  }
}

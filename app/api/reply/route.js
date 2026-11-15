import { streamText, MODELS } from '../../../lib/claude.js';
import { getLevel } from '../../../lib/levels.ts';
import { replySystem, replyUserText } from '../../../lib/prompts.js';
import { serverError } from '../../../lib/http.js';
import { learnerReplySystem, learnerReplyUserText } from '../../../lib/learner/prompts.js';
import { recordReply } from '../../../lib/daily/record.ts';

// The student's spoken reply, streamed as plain text. The app already chose
// what kind of reply this is (lib/student/turns.ts); this only phrases it,
// in response to exactly what the teacher just said.
export const maxDuration = 30;

export async function POST(req) {
  try {
    const body = await req.json();
    const level = getLevel(body.levelId);
    const study = body.mode === 'student'; // Teach to Learn: a curious student probing the user's understanding
    const stream = streamText({
      model: MODELS.fast,
      system: study ? learnerReplySystem(level) : replySystem(level),
      content: [{ type: 'text', text: study ? learnerReplyUserText(body) : replyUserText(body) }],
      maxTokens: 160,
      signal: req.signal,
    });
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
    if (!body.daily) return new Response(stream, { headers });
    // L2T Daily: record what the student actually said, once the reply finished
    // streaming (a reply the user talked over is aborted and not recorded).
    let text = '';
    const dec = new TextDecoder();
    const tap = new TransformStream({
      transform(chunk, ctl) {
        text += dec.decode(chunk, { stream: true });
        ctl.enqueue(chunk);
      },
      async flush() {
        if (!req.signal?.aborted && text.trim()) await recordReply(body.daily, body.intent, text, body.details);
      },
    });
    return new Response(stream.pipeThrough(tap), { headers });
  } catch (err) {
    return serverError(err);
  }
}

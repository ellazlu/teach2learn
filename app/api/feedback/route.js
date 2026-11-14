import { NextResponse } from 'next/server';
import { callJSON, MODELS } from '../../../lib/claude.js';
import { getLevel } from '../../../lib/levels.ts';
import { feedbackSystem, feedbackSchema, feedbackUserText } from '../../../lib/prompts.js';
import { learningSummary, conceptSummary, emptyModel } from '../../../lib/student/knowledge.ts';
import { computeSpeechMetrics } from '../../../lib/student/speech.ts';
import { buildEvidence, validateThree, fallbackThree, evidenceForPrompt } from '../../../lib/student/evidence.ts';
import { serverError } from '../../../lib/http.js';

// Concise, consistent feedback:
//   teacher: one thing that went well, one to improve, one to try next
//            (each must cite timestamped transcript evidence; validated in code)
//   student: concept summary from learning verification (deterministic)
// Teacher performance and simulated student learning are kept separate.
export const maxDuration = 60;

export async function POST(req) {
  try {
    const body = await req.json();
    const { levelId, topicTitle, events = [], utterances = [] } = body;
    const level = getLevel(levelId);
    const initial = body.initial || emptyModel(level.id);
    const final = body.final || initial;

    const checks = events.filter((e) => e.type === 'checked_understanding').map((e) => e.at);
    const metrics = computeSpeechMetrics(utterances, checks);
    const learning = learningSummary(initial, final);
    const concepts = conceptSummary(final);
    const evidence = buildEvidence({ initial, final, events, metrics, learning });
    const spoke = utterances.some((u) => u.speaker === 'teacher');

    let teaching = { ...fallbackThree(evidence), usedFallback: true };
    if (spoke && evidence.length) {
      try {
        const raw = await callJSON({
          model: MODELS.smart,
          system: feedbackSystem(level),
          content: [{ type: 'text', text: feedbackUserText({ evidenceText: evidenceForPrompt(evidence), transcript: utterances, topicTitle }) }],
          schema: feedbackSchema(evidence.map((e) => e.id)),
          maxTokens: 800,
        });
        teaching = validateThree(raw, evidence);
      } catch (err) {
        console.error('feedback LLM failed; using evidence-only feedback', err);
      }
    }

    return NextResponse.json({
      teaching: { went_well: teaching.went_well, improve: teaching.improve, try_next: teaching.try_next },
      usedFallback: teaching.usedFallback,
      spoke,
      concepts,
      evidence,
      metrics,
      learning,
    });
  } catch (err) {
    return serverError(err);
  }
}

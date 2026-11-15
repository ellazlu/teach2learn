import { NextResponse } from 'next/server';
import { callJSON, MODELS } from '../../../lib/claude.js';
import { badRequest } from '../../../lib/http.js';
import { studyFeedbackSystem, studyFeedbackSchema, studyFeedbackUserText } from '../../../lib/learner/prompts.js';
import { buildStudyEvidence, fallbackStudyFeedback, reviewCandidates, studyEvidenceForPrompt, validateStudyFeedback } from '../../../lib/learner/feedback.ts';

// Teach to Learn feedback: content only (correct understanding, knowledge
// gaps, misconceptions, what to review next). Built from tracked evidence; the
// model only phrases it and every citation is checked. Falls back to the
// deterministic version if the model is unavailable.
export const maxDuration = 60;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest('Invalid JSON body.');
  }
  const { learner, extraction = null, utterances = [], boards = [], topicTitle = '', material = '', recurring = [] } = body || {};
  if (!learner || !Array.isArray(learner.concepts)) return badRequest('Session data is missing.');
  const evidence = buildStudyEvidence(learner, boards);
  const base = fallbackStudyFeedback(learner, evidence, extraction, recurring);
  const candidates = reviewCandidates(learner, extraction, recurring);
  const teacherWords = utterances.filter((u) => u.speaker === 'teacher').reduce((n, u) => n + String(u.text).split(/\s+/).length, 0);
  // Too little was said to write anything beyond the deterministic summary.
  if (teacherWords < 25 && !boards.some((b) => !b.blank)) return NextResponse.json({ feedback: base, evidence, candidates });
  try {
    const notes = (extraction?.concepts || []).map((c) => `${c.id} ${c.name}: ${c.description}`).join('\n');
    const raw = await callJSON({
      model: MODELS.smart,
      system: studyFeedbackSystem(),
      content: [{ type: 'text', text: studyFeedbackUserText({ topicTitle, evidenceText: studyEvidenceForPrompt(evidence, learner), conceptNotes: notes, candidates: candidates.slice(0, 3), transcript: utterances.slice(-60), material: String(material).slice(0, 6000) }) }],
      schema: studyFeedbackSchema(evidence.map((e) => e.id), candidates.slice(0, 3).map((c) => c.conceptId)),
      maxTokens: 1200,
    });
    return NextResponse.json({ feedback: validateStudyFeedback(raw, base, evidence, candidates), evidence, candidates });
  } catch (err) {
    console.error('[study-feedback] LLM failed, using deterministic feedback:', err.message);
    return NextResponse.json({ feedback: base, evidence, candidates });
  }
}

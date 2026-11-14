import { NextResponse } from 'next/server';
import { callJSON, sourcesToBlocks, MODELS } from '../../../lib/claude.js';
import { getLevel } from '../../../lib/levels.ts';
import { feedbackSystem, feedbackSchema, feedbackUserText } from '../../../lib/prompts.js';
import { learningSummary, emptyModel } from '../../../lib/student/knowledge.ts';
import { computeSpeechMetrics } from '../../../lib/student/speech.ts';
import { buildEvidence, attachEvidence, fallbackSuggestions, evidenceForPrompt } from '../../../lib/student/evidence.ts';
import { quoteAppearsIn } from '../../../lib/verify.ts';
import { serverError } from '../../../lib/http.js';

// Evidence-based feedback. Metrics, learning summary, and the evidence list are
// computed deterministically here; the LLM only writes suggestions that cite
// evidence ids, and uncited suggestions are dropped. If the LLM fails, the
// evidence is turned into plain suggestions without it.
export const maxDuration = 60;

export async function POST(req) {
  try {
    const body = await req.json();
    const { levelId, topicTitle, events = [], utterances = [], sources = [] } = body;
    const level = getLevel(levelId);
    const initial = body.initial || emptyModel(level.id);
    const final = body.final || initial;

    const checks = events.filter((e) => e.type === 'checked_understanding').map((e) => e.at);
    const metrics = computeSpeechMetrics(utterances, checks);
    const learning = learningSummary(initial, final);
    const evidence = buildEvidence({ initial, final, events, metrics, learning });
    const teacherText = utterances.filter((u) => u.speaker === 'teacher').map((u) => u.text).join(' ');

    let summary = '';
    let suggestions = [];
    let strengths = [];
    let outside = [];
    let usedFallback = false;

    if (teacherText.trim()) {
      try {
        const raw = await callJSON({
          model: MODELS.smart,
          system: feedbackSystem(level),
          content: [
            ...sourcesToBlocks(sources),
            { type: 'text', text: feedbackUserText({ evidenceText: evidenceForPrompt(evidence), transcript: utterances, learning, topicTitle }) },
          ],
          schema: feedbackSchema(evidence.map((e) => e.id)),
          maxTokens: 4000,
        });
        summary = raw.summary || '';
        suggestions = attachEvidence(raw.suggestions, evidence);
        strengths = attachEvidence((raw.strengths || []).map((s) => ({ title: s.point, detail: s.point, evidence_ids: s.evidence_ids })), evidence)
          .filter((s) => s.evidence.some((e) => e.positive))
          .map((s) => ({ point: s.title, evidence: s.evidence }));
        outside = (raw.outside_knowledge || []).filter((o) => quoteAppearsIn(o.student_quote, teacherText));
      } catch (err) {
        console.error('feedback LLM failed, using evidence-only fallback', err);
      }
    }
    if (!suggestions.length) {
      suggestions = fallbackSuggestions(evidence);
      usedFallback = true;
    }
    if (!summary) {
      summary = teacherText.trim()
        ? 'Here is what the session showed, based on what you said and how your student responded.'
        : 'No speech was captured, so there was nothing to review. Check your microphone or use "Type instead".';
    }

    return NextResponse.json({ summary, suggestions, strengths, outside_knowledge: outside, evidence, metrics, learning, usedFallback });
  } catch (err) {
    return serverError(err);
  }
}

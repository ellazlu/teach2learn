// All LLM prompts and their JSON schemas. The LLM interprets and phrases;
// the app (lib/student/*) owns all student state.

import { fmt } from './student/speech.ts';

const enumOrString = (values) => (values.length ? { type: 'string', enum: values } : { type: 'string' });

// ---------------------------------------------------------------------------
// 1. EXTRACTION: notes or topic -> concepts + realistic misconceptions
// ---------------------------------------------------------------------------

export function extractionSystem(level, fromMaterial) {
  return `You are preparing a simulated student for a "learn by teaching" session. A user will teach ${level.who} about the topic below.

${fromMaterial
    ? 'Use ONLY the SOURCE MATERIAL. Do not add concepts, facts, or terms that are not in it.'
    : 'No material was uploaded; only a topic name. Choose the core concepts a good lesson on this topic would cover for this learner, using standard, uncontroversial knowledge.'}

Return:
- topic_title (max 8 words) and overview (2-3 sentences).
- concepts: 5-10 major concepts in a sensible teaching order. ids c1, c2, ... For each: name, a one-sentence description of what a correct explanation says, difficulty 1 (basic) to 5 (advanced), prerequisites (ids of EARLIER concepts this one builds on), key_terms (terms the material uses for it).
- misconceptions: 3-4 realistic wrong beliefs ${level.who} might really hold about these concepts, e.g. "heavier objects always fall faster". ids m1, m2, ... Each has the concept_id it belongs to, the belief written the way the student would think it, and the correction a teacher must establish to fix it. Prefer misconceptions about the most basic concepts.
${fromMaterial ? 'The corrections must be supported by the source material.' : ''}`;
}

export const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    topic_title: { type: 'string' },
    overview: { type: 'string' },
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          difficulty: { type: 'integer' },
          prerequisites: { type: 'array', items: { type: 'string' } },
          key_terms: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'name', 'description', 'difficulty', 'prerequisites', 'key_terms'],
      },
    },
    misconceptions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          concept_id: { type: 'string' },
          belief: { type: 'string' },
          correction: { type: 'string' },
        },
        required: ['id', 'concept_id', 'belief', 'correction'],
      },
    },
  },
  required: ['topic_title', 'overview', 'concepts', 'misconceptions'],
};

// ---------------------------------------------------------------------------
// 2. EVALUATION: one stable teacher segment -> proposed observations
// ---------------------------------------------------------------------------

export function evaluationSystem(level) {
  return `You evaluate one segment of a live lesson in which a user is teaching ${level.who}.
Judge ONLY the teacher's words inside <segment>, against the concept list (what a correct explanation says) and the learner's listed misconceptions. You report observations; the app decides what the learner learns. Every observation needs a quote copied exactly from <segment> (3-25 words).

concepts: one entry for each concept the segment actually touches (skip the rest):
- explained: true only if the teacher actually explained it (what it is, how, or why). Just naming it is false.
- correctness: correct, partially_correct, or incorrect, judged against the concept description.
- clarity: clear, somewhat_clear, or unclear for ${level.who}.
- level_fit: appropriate, too_advanced, or too_simple for ${level.who}.
- used_example: true if they gave an example or analogy for it.
- gap: if ${level.who} would still be stuck on something SPECIFIC about this concept after hearing this segment, write the exact question they would ask, max 15 words, in plain words, grounded in what the teacher actually said. Example: teacher says "gravity pulls the planets toward the Sun" -> gap "If gravity pulls the planets in, why don't they fall into the Sun?". Never write a vague gap like "how does it work?" or "can you explain more?". Use "" if the explanation fully landed.

misconceptions: only when the words speak directly to one of the listed beliefs:
- corrected: clearly establishes the correction, so the belief can't survive.
- partially_corrected: touches it but leaves room for the belief.
- reinforced: says something that supports the wrong belief.
Talking about the related concept without addressing the belief is NOT a correction.

undefined_terms: technical terms used in this segment without explanation that ${level.who} would not know. Usually empty for an expert.

question_response: about the learner's open question (if any): full = the segment directly and correctly answers it, partial = touches it, none = doesn't address it.

checked_understanding: true if the teacher checked whether the learner understood ("does that make sense?", "can you tell me…?").

Use <earlier_context> only to understand the segment; never quote it. Transcripts come from speech recognition, so read obviously misheard words as intended. Don't report anything the segment doesn't support.`;
}

export function evaluationSchema(conceptIds, misconceptionIds) {
  return {
    type: 'object',
    properties: {
      concepts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            concept_id: enumOrString(conceptIds),
            explained: { type: 'boolean' },
            correctness: { type: 'string', enum: ['correct', 'partially_correct', 'incorrect'] },
            clarity: { type: 'string', enum: ['clear', 'somewhat_clear', 'unclear'] },
            level_fit: { type: 'string', enum: ['appropriate', 'too_advanced', 'too_simple'] },
            used_example: { type: 'boolean' },
            quote: { type: 'string' },
            gap: { type: 'string' },
          },
          required: ['concept_id', 'explained', 'correctness', 'clarity', 'level_fit', 'used_example', 'quote', 'gap'],
        },
      },
      misconceptions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            misconception_id: enumOrString(misconceptionIds),
            effect: { type: 'string', enum: ['corrected', 'partially_corrected', 'reinforced'] },
            quote: { type: 'string' },
          },
          required: ['misconception_id', 'effect', 'quote'],
        },
      },
      undefined_terms: {
        type: 'array',
        items: {
          type: 'object',
          properties: { term: { type: 'string' }, quote: { type: 'string' } },
          required: ['term', 'quote'],
        },
      },
      question_response: {
        type: 'object',
        properties: { quality: { type: 'string', enum: ['full', 'partial', 'none'] }, quote: { type: 'string' } },
        required: ['quality', 'quote'],
      },
      checked_understanding: {
        type: 'object',
        properties: { happened: { type: 'boolean' }, quote: { type: 'string' } },
        required: ['happened', 'quote'],
      },
    },
    required: ['concepts', 'misconceptions', 'undefined_terms', 'question_response', 'checked_understanding'],
  };
}

export function evaluationUserText({ model, openQuestion, earlierContext, segment }) {
  return `<concepts>
${JSON.stringify(model.concepts.map(({ id, name, description, key_terms }) => ({ id, name, description, key_terms })), null, 1)}
</concepts>

<misconceptions>
${JSON.stringify(model.misconceptions.map(({ id, concept_id, belief, correction, status }) => ({ id, concept_id, belief, correction, status })), null, 1)}
</misconceptions>

<open_question>${openQuestion || '(none)'}</open_question>

<earlier_context>
${earlierContext || '(start of lesson)'}
</earlier_context>

<segment>
${segment}
</segment>`;
}

// ---------------------------------------------------------------------------
// 3. DIALOGUE: the app picks the intent; the LLM only phrases it in character
// ---------------------------------------------------------------------------

const INTENTS = {
  define_term: (x) => `Ask what "${x.term}" means. Use the word the way the teacher said it.`,
  clarify: (x) =>
    x.focusQuestion
      ? `You're stuck on one specific point: "${x.focusQuestion}". The teacher had said: "${x.focusQuote}". Ask about exactly that point, pointing back to their words (e.g. "You said…, but then why…?").`
      : `Pick the ONE specific part of what the teacher just said about ${x.conceptName} that you understood least ("${x.teacherWords}") and ask about exactly that, echoing their words.`,
  example: (x) =>
    x.focusQuestion
      ? `Ask for an example that would answer what you're stuck on: "${x.focusQuestion}".`
      : `Ask for an example of ${x.conceptName}, naming the specific part you want it to show.`,
  relate: (x) => `Ask how ${x.conceptName} connects to ${x.relatedName || 'what they explained before'}.`,
  prerequisite: (x) => `They are building on ${x.conceptName}, which you don't really understand yet. Ask about it.`,
  misconception: (x) => `You genuinely believe: "${x.belief}". Say it as a hesitant thought or question, e.g. "Wait, but don't…?". Do not give the right answer.`,
  follow_up: (x) => `They didn't fully answer your question "${x.previousQuestion}". Ask again, more specifically.`,
  challenge: (x) => `Probe an edge case, exception, or precise condition of ${x.conceptName}, staying within: ${x.conceptDescription}`,
  check_in: (x) =>
    `They've been talking a while. In a few words, say what you think you've got so far about ${x.conceptName}${x.focusQuestion ? `, then ask "${x.focusQuestion}"` : ' and ask if that is right'}.`,
  curiosity: (x) => `Ask a curious question that leads toward this idea without naming its technical terms: ${x.conceptDescription}`,
  show_understanding: (x) => `You just understood ${x.conceptName}. Say it back briefly in your own words, using only what the teacher said: "${x.teacherWords}". Sound pleased. Don't add new facts.`,
};

export function dialogueSystem(level) {
  return `You are ${level.who}, being taught by a user right now. Speak in character: exactly how ${level.who} talks out loud.
${level.questionStyle ? `Your style: ${level.questionStyle}.` : ''}
The app has already decided WHAT you will say. Your only job is to phrase it naturally.
- One utterance, at most ${level.id === 'kindergarten' ? 12 : 25} words. No preamble, no quotation marks.
- Only use technical terms the teacher has already said (see <teacher_said>), unless the intent tells you otherwise.
- Never state facts the teacher hasn't taught, and never give away answers.
- Reflect what you understand so far (<what_you_know>).
- Be specific. Name the exact thing you're stuck on, using the teacher's own words. Never say vague things like "Can you explain it another way?", "I sort of get it but not quite", or "I'm confused" on their own.`;
}

export const DIALOGUE_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

export function dialogueUserText({ intent, details, teacherSaid, whatYouKnow, alreadyAsked }, retryNote = '') {
  const f = INTENTS[intent] || INTENTS.clarify;
  return `<intent>
${f(details)}
</intent>

<what_you_know>
${whatYouKnow}
</what_you_know>

<teacher_said>
${teacherSaid || '(nothing yet)'}
</teacher_said>

<already_said>
${(alreadyAsked || []).map((q) => `- ${q}`).join('\n') || '(nothing)'}
</already_said>

Don't repeat anything in <already_said>. Write what you say.${retryNote ? `\n\n${retryNote}` : ''}`;
}

// ---------------------------------------------------------------------------
// 4. FEEDBACK: evidence list -> conversational, evidence-cited suggestions
// ---------------------------------------------------------------------------

export function feedbackSystem(level) {
  return `You are a supportive teaching coach. A user just taught ${level.who} (a simulated student) to deepen their own understanding of the material. The app has already measured what happened and gives you numbered EVIDENCE. Write feedback grounded in it.

Rules:
- Every suggestion and strength must cite the evidence ids it is based on. Anything you can't tie to evidence, leave out. No generic advice like "try being clearer".
- suggestions: 3-5, most important first. title = short imperative. detail = 1-2 conversational sentences that say what happened (mention the time, e.g. "At 1:42…") and what to do differently, and why it would help ${level.who}. Prioritize conceptual errors, unresolved misconceptions, unanswered questions, and prerequisite gaps over speaking style.
- Speaking-style evidence (pace, long stretches, pauses) is context, not a verdict: faster speech or fewer pauses aren't automatically better. Explain the effect on this learner.
- strengths: 1-3, citing positive evidence.
- summary: two warm, honest sentences on how the lesson went and the single biggest thing to work on.
- outside_knowledge: terms or ideas the user said (quote them exactly from the transcript) that are NOT in the material but are directly relevant. Judge correctness with general knowledge; praise correct ones briefly, correct wrong ones. Ignore off-topic tangents. Empty if none or if no material was uploaded.
- Mastery numbers are simulated estimates; don't present them as measurements of real learning.`;
}

export function feedbackSchema(evidenceIds) {
  const ids = { type: 'array', items: enumOrString(evidenceIds) };
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, detail: { type: 'string' }, evidence_ids: ids },
          required: ['title', 'detail', 'evidence_ids'],
        },
      },
      strengths: {
        type: 'array',
        items: {
          type: 'object',
          properties: { point: { type: 'string' }, evidence_ids: ids },
          required: ['point', 'evidence_ids'],
        },
      },
      outside_knowledge: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            term_or_idea: { type: 'string' },
            student_quote: { type: 'string' },
            correct: { type: 'boolean' },
            comment: { type: 'string' },
          },
          required: ['term_or_idea', 'student_quote', 'correct', 'comment'],
        },
      },
    },
    required: ['summary', 'suggestions', 'strengths', 'outside_knowledge'],
  };
}

export function feedbackUserText({ evidenceText, transcript, learning, topicTitle }) {
  const lines = transcript.map((u) => `[${fmt(u.start)}] ${u.speaker === 'student' ? 'Student' : 'Teacher'}: ${u.text}`).join('\n');
  return `Topic: ${topicTitle}

<evidence>
${evidenceText || '(no evidence recorded)'}
</evidence>

<simulated_learning>
Learned: ${learning.learned.map((l) => `${l.name} (${l.from}→${l.to})`).join(', ') || 'nothing measurable'}
Still confusing: ${learning.stillConfusing.map((l) => `${l.name} (${l.why})`).join(', ') || 'nothing'}
Not covered: ${learning.notCovered.map((l) => l.name).join(', ') || 'nothing'}
Misconceptions: ${learning.misconceptions.map((m) => `"${m.belief}" ${m.from}→${m.to}`).join('; ') || 'none'}
</simulated_learning>

<transcript>
${lines}
</transcript>`;
}

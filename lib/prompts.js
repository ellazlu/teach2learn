// All LLM prompts and their JSON schemas. The LLM interprets and phrases;
// the app (lib/student/*) owns all student state.

import { fmt } from './student/speech.ts';

const enumOrString = (values) => (values.length ? { type: 'string', enum: values } : { type: 'string' });

// ---------------------------------------------------------------------------
// 1. EXTRACTION: notes or topic -> concepts + realistic misconceptions
// ---------------------------------------------------------------------------

export function extractionSystem(level, fromMaterial) {
  return `You are preparing a simulated student for a short (about 2 minute) "learn by teaching" session. A user will teach ${level.who} about the topic below.

${fromMaterial
    ? 'Use ONLY the SOURCE MATERIAL. Do not add concepts, facts, or terms that are not in it.'
    : 'No material was uploaded; only a topic name. Use standard, uncontroversial knowledge appropriate for this learner.'}

Return:
- topic_title (max 8 words) and overview (1-2 sentences).
- concepts: the 1-3 KEY concepts a 2-minute lesson on this would cover, in teaching order (ids c1, c2, c3). Not the whole subject. For each: name, a one-sentence description of what a correct explanation must say, difficulty 1 (basic) to 5 (advanced) for this learner, prerequisites (ids of EARLIER concepts in this list), key_terms (the words the material uses for it).
- misconceptions: 1-2 realistic wrong beliefs ${level.who} might genuinely hold about these concepts (e.g. "heavier objects always fall faster"). ids m1, m2. Each has concept_id, the belief in the student's own words, and the correction a teacher must establish.${fromMaterial ? ' Corrections must be supported by the material.' : ''}`;
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
- correctness, judged against the concept description:
  - correct: accurate AND covers the essential idea, including why/how where the reason is essential. Concise is fine; never require extra detail, length or examples.
  - partially_correct: accurate as far as it goes but shallow: states what happens without the essential reason, or leaves out an essential part.
  - incorrect: contains any factual error about the concept, even a small one (a wrong cause, quantity, direction, or term used wrongly).
- clarity: clear, somewhat_clear, or unclear for ${level.who}.
- level_fit: appropriate, too_advanced, or too_simple for ${level.who}.
- used_example: true if they gave an example or analogy for it.
- gap: if ${level.who} would still be stuck on something SPECIFIC about this concept after hearing this segment, write the exact question they would ask, max 15 words, in plain words, grounded in what the teacher actually said. Example: teacher says "gravity pulls the planets toward the Sun" -> gap "If gravity pulls the planets in, why don't they fall into the Sun?". Never write a vague gap like "how does it work?" or "can you explain more?". Use "" if the explanation fully landed.

misconceptions: only when the words speak directly to one of the listed beliefs:
- corrected: clearly establishes the correction, so the belief can't survive.
- partially_corrected: touches it but leaves room for the belief.
- reinforced: says something that supports the wrong belief.
Talking about the related concept without addressing the belief is NOT a correction.

undefined_terms: ONLY technical terms used without explanation that ${level.who} would genuinely not know. They already know ${level.knows}. Never list basic or age-appropriate vocabulary; if unsure, leave it out. Usually empty for college students and experts.

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
// 3. REPLY: the app picks the action; one streamed call phrases it in
//    character, responding to exactly what the teacher just said.
// ---------------------------------------------------------------------------

const INTENTS = {
  define_term: (x) => `Ask what "${x.term}" means, the way they just used it.`,
  clarify: (x) =>
    x.focusQuestion
      ? `You're stuck on one specific point: "${x.focusQuestion}". Ask about exactly that, pointing back to their words.`
      : `Ask about the ONE specific part of what they just said about ${x.conceptName} that doesn't make sense to you yet.`,
  example: (x) => `Ask for an example that shows ${x.focusQuestion ? `the answer to "${x.focusQuestion}"` : x.conceptName}, saying which part you want it to show.`,
  relate: (x) => `Ask how ${x.conceptName} connects to ${x.relatedName || 'what they explained before'}.`,
  prerequisite: (x) => `They're building on ${x.conceptName}, which you don't understand yet. Ask about it.`,
  misconception: (x) => `You genuinely believe: "${x.belief}". What they just said seems to clash with that. Say so naturally as a question ("Wait, but…?"). Don't give the right answer.`,
  follow_up: (x) => `Their answer to "${x.previousQuestion}" didn't fully settle it. Ask about the part that's still missing.`,
  challenge: (x) => `Probe an edge case or exception of ${x.conceptName}, within: ${x.conceptDescription}`,
  check_in: (x) => `Say in a few words what you think you've got about ${x.conceptName} so far, and ask if that's right.`,
  curiosity: (x) => `Ask a curious question that leads toward this idea, without its technical terms: ${x.conceptDescription}`,
  acknowledge: () => `Briefly show you're following: one short sentence that echoes the specific point they just made. Don't ask a question; let them keep going.`,
  react_to_answer: (x) => `They just answered your question "${x.previousQuestion}". If their answer settles it, say in a few words what you now get (echo their point). If it doesn't, ask about exactly what's still missing in one short question.`,
  answer_check: () => `They asked if you understand. Answer honestly from <what_you_know>: if something is still unclear, say exactly what; otherwise say yes briefly and say the key point back in a few words.`,
  answer_content: () => `They asked you a question. Answer it as yourself, using only <what_you_know>, what they've taught you, and everyday common sense for your age. If you're not sure, reason it out and make your best guess (it's fine to be wrong, and your current beliefs show).`,
  explain_back: (x) => `Explain ${x.conceptName} back in your own words in 1-2 sentences, using ONLY what the teacher told you (<taught>). Start naturally ("So basically…" / "Wait, let me see if I get it…"). If they told you something wrong or left something out, your explanation reflects that. End by asking if you got it right.`,
  apply: (x) => `Apply ${x.conceptName} to a NEW everyday example the teacher didn't use, reasoning it through in 1-2 sentences based only on what you were taught (<taught>), then ask if you're right.`,
};

export function replySystem(level) {
  const limit = level.id === 'kindergarten' ? 16 : 30;
  return `You are ${level.who} in a live lesson, talking out loud with the person teaching you.
You understand ${level.understands}. Use the vocabulary of ${level.who}, but think clearly: you are bright and you learn from good explanations.
Your style: ${level.questionStyle}.

The app has already decided what you will do (<what_to_do>). Do exactly that, as a natural spoken reply to what the teacher JUST said (<teacher_just_said>).
- Speak like a real person: short, casual, contractions, no lists, no stage directions, no emoji. Usually one sentence; at most ${limit} words (explanations back: at most ${limit + 15}).
- Respond to their actual words. Never ask something they just answered, and never repeat yourself (<already_said>).
- You already know what a typical ${level.who} knows: ${level.knows}. Never ask what basic, age-appropriate words mean. About this lesson's topic, only know what's in <what_you_know>; never state facts they haven't taught or give away answers.
- Be specific. Never say vague things like "Can you explain it another way?" or "I'm confused" on their own.`;
}

export function replyUserText(b) {
  const f = INTENTS[b.intent] || INTENTS.acknowledge;
  const convo = (b.conversation || []).map((u) => `${u.speaker === 'student' ? 'You' : 'Teacher'}: ${u.text}`).join('\n');
  const persona = b.persona ? `<who_you_are_today>\n${String(b.persona).slice(0, 400)}\n(Stay in this character, but still do exactly what <what_to_do> says.)\n</who_you_are_today>\n\n` : '';
  return `${persona}<what_you_know>
${b.knowledge || '(nothing yet)'}
</what_you_know>

<taught>
${b.taught || '(nothing specific yet)'}
</taught>

<conversation>
${convo || '(just started)'}
</conversation>

<already_said>
${(b.alreadySaid || []).map((q) => `- ${q}`).join('\n') || '(nothing)'}
</already_said>

<teacher_just_said>
${b.teacherJustSaid}
</teacher_just_said>

<what_to_do>
${f({ ...(b.details || {}), previousQuestion: b.previousQuestion || b.details?.previousQuestion || '' })}
</what_to_do>

Say it now (just the words you say out loud).`;
}

// ---------------------------------------------------------------------------
// 3b. VERIFY: did the student's statement demonstrate understanding?
// ---------------------------------------------------------------------------

export function verifySystem(level) {
  return `You check whether a simulated student (${level.who}) has demonstrated understanding of a concept, by comparing what the student said with what a correct explanation must say (the lesson material).
- demonstrated: the student's statement correctly captures the essential idea in the description, in their own words. Vocabulary at their level is fine; technical terms are not required.
- partial: some of it is right, but an essential part is missing or vague.
- not_demonstrated: wrong, contradicts the material, or doesn't address the concept.
Judge only the student's statement against the description. Be strict: restating a word without the idea is not understanding.
note: max 20 words, plain, saying what they got right or what's missing/wrong.`;
}

export const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['demonstrated', 'partial', 'not_demonstrated'] },
    note: { type: 'string' },
  },
  required: ['verdict', 'note'],
};

export function verifyUserText({ concept, mode, statement, taught }) {
  return `<concept>
${concept.name}: ${concept.description}
</concept>

<what_the_teacher_said_about_it>
${taught || '(not recorded)'}
</what_the_teacher_said_about_it>

<student_statement mode="${mode}">
${statement}
</student_statement>`;
}

// ---------------------------------------------------------------------------
// 4. FEEDBACK: evidence list -> one strength, one weakness, one next step
// ---------------------------------------------------------------------------

export function feedbackSystem(level) {
  return `You are a concise teaching coach. A user just taught ${level.who} (a simulated student) for about two minutes to deepen their own understanding. The app measured what happened and gives you numbered EVIDENCE from the transcript.

Write exactly three items, each grounded in ONE evidence id:
- went_well: the single most meaningful thing the teacher did well (must cite evidence marked "went well").
- improve: the single most important weakness (must cite evidence marked "issue"). Prefer content problems (wrong or missing ideas, unanswered questions, unresolved misconceptions, unexplained terms) over speaking style.
- try_next: one concrete, actionable thing to do next time that fixes the "improve" item. Cite the same or related evidence.

Rules: one sentence each, max 25 words, plain and specific to what happened. Don't write timestamps (the app shows them). No generic praise, no hedging, no grades or numbers about the student's learning. Never contradict the evidence. If no evidence is marked "went well", went_well.evidence_id is "none".`;
}

export function feedbackSchema(evidenceIds) {
  const id = { type: 'string', enum: [...evidenceIds, 'none'] };
  const item = { type: 'object', properties: { text: { type: 'string' }, evidence_id: id }, required: ['text', 'evidence_id'] };
  return {
    type: 'object',
    properties: { went_well: item, improve: item, try_next: item },
    required: ['went_well', 'improve', 'try_next'],
  };
}

export function feedbackUserText({ evidenceText, transcript, topicTitle }) {
  const lines = transcript.map((u) => `[${fmt(u.start)}] ${u.speaker === 'student' ? 'Student' : 'Teacher'}: ${u.text}`).join('\n');
  return `Topic: ${topicTitle}

<evidence>
${evidenceText || '(no evidence recorded)'}
</evidence>

<transcript>
${lines}
</transcript>`;
}

// All three prompts and their JSON output schemas live here, so prompt tuning
// happens in one file. Each prompt is paired with a "tool" whose input_schema
// forces the model to answer in that exact JSON shape.

// ---------------------------------------------------------------------------
// 1. PREP: source material -> overview, concepts, rubric
// ---------------------------------------------------------------------------

export function prepSystem(level) {
  return `You are preparing a "learn by teaching" session. A student will teach the topic in the SOURCE MATERIAL out loud to an imaginary learner, and will then be graded on what that learner wrote down.

Learner: ${level.who}. This learner understands ${level.understands}.
Rubric depth for this learner: ${level.depth}

Your job:
1. topic_title, overview, concepts: summarize what the source material covers and list ALL of its key concepts, regardless of the learner's level. This is the student's map of the material.
2. rubric: list what this learner should have in their notes after a complete, good lesson on this material. Aim for ${level.rubricCount} items, ordered from most to least central.

Hard rules:
- Use ONLY the source material. Do not add facts, examples, terms, or concepts that are not in it, even if they are standard for the topic. If the material is thin, the rubric is short.
- Every concept and every rubric item needs source_quote: an exact excerpt (at most about 30 words) copied character-for-character from the source, and source_name: the name of the source it came from. If you cannot quote the source for an item, leave the item out.
- Write each rubric criterion as one checkable statement about the learner's notes, phrased at the learner's level. Example: "Notes say that plants make their own food using sunlight."
- One idea per rubric item. key_terms lists vocabulary from the source the learner should have been given (use an empty list where vocabulary doesn't matter at this level).
- If the student gave focus instructions, use them to choose what to cover, but they never permit going beyond the source.`;
}

const quoteFields = {
  source_name: { type: 'string', description: 'Name of the source this came from, exactly as given.' },
  source_quote: { type: 'string', description: 'Exact excerpt copied character-for-character from that source, max ~30 words.' },
};

export const PREP_TOOL = {
  name: 'save_session_plan',
  description: 'Save the overview, concept map, and grading rubric for the teaching session.',
  input_schema: {
    type: 'object',
    properties: {
      topic_title: { type: 'string', description: 'Short title for the topic, max 8 words.' },
      overview: { type: 'string', description: '3-5 plain sentences on what the source material covers.' },
      concepts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'C1, C2, ...' },
            name: { type: 'string' },
            summary: { type: 'string', description: 'One sentence, using only the source.' },
            key_terms: { type: 'array', items: { type: 'string' } },
            ...quoteFields,
          },
          required: ['id', 'name', 'summary', 'key_terms', 'source_name', 'source_quote'],
        },
      },
      rubric: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'R1, R2, ...' },
            criterion: { type: 'string', description: "One checkable sentence about what the learner's notes should show." },
            concept_ids: { type: 'array', items: { type: 'string' } },
            key_terms: { type: 'array', items: { type: 'string' } },
            ...quoteFields,
          },
          required: ['id', 'criterion', 'concept_ids', 'key_terms', 'source_name', 'source_quote'],
        },
      },
    },
    required: ['topic_title', 'overview', 'concepts', 'rubric'],
  },
};

// ---------------------------------------------------------------------------
// 2. NOTE-TAKER: runs every ~15s on the newest chunk of speech.
// It never sees the rubric or the source, so it can't "fill in" what the
// student was supposed to say.
// ---------------------------------------------------------------------------

export function notesSystem(level) {
  return `You are ${level.who}, listening to someone teach you and taking notes in your notebook.
You understand ${level.understands}. You get lost by ${level.lostBy}.

You will receive the newest part of what the teacher said (from speech recognition, so expect small transcription errors), plus your most recent notes and the end of the earlier transcript for context.

Write notes ONLY for the new part:
- Each note is one short sentence, at most about 20 words. One idea per note.
- Be an honest mirror. Write down what the teacher actually said, even if it is wrong or incomplete. Never correct them, never add facts, examples, or terms they didn't say, and never fill in what you think they meant.
- Use the teacher's own words whenever you can. Set verbatim to true when the note is an exact quote of the teacher.
- Write down key terms and the definitions the teacher gives for them.
- kind "lost": when the teacher uses a word or idea that you, as ${level.who}, would not understand and they did not explain it in a way you could follow. The text is the exact phrase that lost you. Don't also write a normal note for that same idea.
- Only note what you, at your level, actually took in. Ideas you could follow become normal notes; ones you couldn't become "lost" notes.
- Skip greetings, filler, off-topic chatter, and anything already in your recent notes.
- If the new part has nothing worth noting, return an empty list.`;
}

export const NOTES_TOOL = {
  name: 'add_notes',
  description: "Append new notes to the learner's notebook.",
  input_schema: {
    type: 'object',
    properties: {
      notes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['note', 'lost'] },
            text: { type: 'string' },
            verbatim: { type: 'boolean' },
          },
          required: ['kind', 'text', 'verbatim'],
        },
      },
    },
    required: ['notes'],
  },
};

export function notesUserText({ contextTail, recentNotes, newSpeech }) {
  const notes = (recentNotes || []).map((n) => `- ${n.kind === 'lost' ? '[LOST] ' : ''}${n.text}`).join('\n');
  return `<earlier_transcript_end>
${contextTail || '(start of lesson)'}
</earlier_transcript_end>

<my_recent_notes>
${notes || '(none yet)'}
</my_recent_notes>

<new_speech>
${newSpeech}
</new_speech>`;
}

// ---------------------------------------------------------------------------
// 3. GRADER: rubric + notes + transcript -> graded rubric and feedback
// ---------------------------------------------------------------------------

export function gradeSystem(level) {
  return `You grade a "learn by teaching" session. A student taught the SOURCE MATERIAL out loud to ${level.who}. A learner took notes while listening. You grade the lesson strictly on CONTENT.

You receive: the source material, its concept list, the rubric, the learner's notes ("LOST" notes mean the learner did not understand that phrase), and the full transcript (from speech recognition: when a misheard word is obviously meant to be another word, read it as intended).

Grading rules:
- Judge only what was taught. Ignore delivery entirely: filler words, pace, grammar, accent, nervousness, the order of topics, and transcription errors.
- Be strict and literal. Never give credit for what the student probably meant or probably knows.
- For each rubric item, choose a status:
  - met: the idea was clearly and correctly taught in a way this learner could follow.
  - partial: the idea was only partly covered, stated vaguely, missing a key term the rubric asks for, or covered only in a way that lost the learner (it appears only as a LOST note or as unexplained jargon).
  - missing: not taught, or taught incorrectly.
- evidence_quote: for met or partial, copy the exact words from the TRANSCRIPT (not the notes) that support it, 3-30 words, verbatim. If you can't find supporting words in the transcript, the status is missing and evidence_quote is "".
- misconceptions: statements in the transcript that contradict the source material. Quote the student exactly, explain the problem in one sentence, and quote the source passage that shows the correct version.
- outside_knowledge: terms or ideas the student used that do NOT appear in the source material, only when they are directly relevant to one of the listed concepts (give its concept id). Use your general knowledge to judge whether they used it correctly. If correct, the comment briefly praises how it deepens the topic. If incorrect, the comment says what's wrong. Ignore off-topic tangents entirely. Outside knowledge never changes a rubric status.
- lost_moments: for each LOST note, give the phrase and a one-sentence tip for explaining that idea to ${level.who}.
- suggestions: 2-4 concrete next steps, most important first, focused on missing and partial items and on misconceptions. You may bring in general knowledge that is relevant to the source material to help the student broaden their understanding; say clearly when something goes beyond their material.
- summary: two honest, specific sentences. No generic praise.`;
}

export const GRADE_TOOL = {
  name: 'submit_grade',
  description: 'Submit the graded rubric and feedback for the session.',
  input_schema: {
    type: 'object',
    properties: {
      rubric_results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            rubric_id: { type: 'string' },
            status: { type: 'string', enum: ['met', 'partial', 'missing'] },
            evidence_quote: { type: 'string' },
            reason: { type: 'string', description: 'One sentence.' },
          },
          required: ['rubric_id', 'status', 'evidence_quote', 'reason'],
        },
      },
      misconceptions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            user_quote: { type: 'string' },
            issue: { type: 'string' },
            source_quote: { type: 'string' },
          },
          required: ['user_quote', 'issue', 'source_quote'],
        },
      },
      outside_knowledge: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            term_or_idea: { type: 'string' },
            user_quote: { type: 'string' },
            related_concept_id: { type: 'string' },
            correct: { type: 'boolean' },
            comment: { type: 'string' },
          },
          required: ['term_or_idea', 'user_quote', 'related_concept_id', 'correct', 'comment'],
        },
      },
      lost_moments: {
        type: 'array',
        items: {
          type: 'object',
          properties: { phrase: { type: 'string' }, tip: { type: 'string' } },
          required: ['phrase', 'tip'],
        },
      },
      suggestions: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
    },
    required: ['rubric_results', 'misconceptions', 'outside_knowledge', 'lost_moments', 'suggestions', 'summary'],
  },
};

export function gradeUserText(plan, transcript, notes) {
  const concepts = plan.concepts.map(({ id, name, summary, key_terms }) => ({ id, name, summary, key_terms }));
  const rubric = plan.rubric.map(({ id, criterion, key_terms, source_quote }) => ({ id, criterion, key_terms, source_quote }));
  const notebook = (notes || []).map((n) => `- ${n.kind === 'lost' ? '[LOST] ' : ''}${n.text}`).join('\n');
  return `<concepts>
${JSON.stringify(concepts, null, 2)}
</concepts>

<rubric>
${JSON.stringify(rubric, null, 2)}
</rubric>

<learner_notes>
${notebook || '(no notes)'}
</learner_notes>

<transcript>
${transcript}
</transcript>

Grade every rubric item.`;
}

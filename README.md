# teach2learn

Learn it by teaching it. Pick a topic (and optionally upload notes), pick who you're teaching (kindergartner → expert), hit **Start session**, and explain it out loud. A simulated student listens, learns (or doesn't), voices its misconceptions, and asks questions. At the end you see what it learned and evidence-backed suggestions for teaching it better.

The student is not just a personality prompt: it has an explicit knowledge model that code updates deterministically. The LLM only proposes observations and phrases dialogue.

## Run it

Needs Node 22.6+ and Chrome.

```bash
npm install
cp .env.example .env.local     # add your Anthropic API key
npm run dev                    # http://localhost:3000 in Chrome, allow the mic
```

No mic? Use **Type instead** under the conversation.

## How it works

```
Setup ─► Start session ─► live session ───────────────────────────────► End ─► feedback
            │                 │
   /api/prepare (bg)    mic → final results → stable segments
   concepts +                  │
   misconceptions        /api/evaluate  (LLM proposes observations + quotes)
            │                  │
            └──► StudentModel ◄┘ applyEvaluation()  ← deterministic, quote-checked
                      │
              behavior state machine → decideAction() → selectQuestion()  ← deterministic
                      │
                 /api/speak  (LLM phrases the chosen intent in character) → TTS
```

| Module | File | What it does |
|---|---|---|
| Concept extraction | `app/api/prepare`, `lib/prompts.js` | 5–10 concepts (difficulty, prerequisites, key terms) + realistic misconceptions, from notes or a topic name |
| Knowledge model | `lib/student/knowledge.ts` | Initial mastery per level/difficulty/prerequisites; `applyEvaluation()` update engine |
| Misconceptions | `lib/student/misconceptions.ts` | active → partially addressed → resolved; caps mastery while active |
| Question selection | `lib/student/questions.ts` | Weighted scoring picks the target concept and question type |
| Behavior | `lib/student/behavior.ts` | listening / curious / confused / understanding / challenging / responding + interjection policy |
| Specific questions | `lib/student/dialogue.ts` | Rejects vague lines; builds a targeted fallback |
| Segmentation | `lib/student/segments.ts` | Only settled speech is evaluated; echo filter |
| Orchestration | `lib/student/engine.ts` | `SessionEngine`: single-flight evaluation, one utterance at a time, failure-safe |
| Speech analysis | `lib/student/speech.ts` | WPM, pauses, fillers, longest stretch, talk share, response latency |
| Feedback | `lib/student/evidence.ts`, `app/api/feedback` | Timestamped evidence; LLM suggestions must cite it |
| Persistence | `lib/history.ts` | localStorage, versioned records, migrates old saves |
| UI | `components/` | Avatar (placeholder), StudentPanel, Session, Results, History |

### The student knowledge model
- **Initial mastery** = level base − difficulty penalty − 4 per prerequisite ± a small stable jitter. A kindergartner starts near 0–8 and an expert around 45–62. Each level also starts with a different number of misconceptions.
- **Updates.** For each stable teacher segment (about 25 words, or a 2.5s pause), the LLM reports per concept: explained or just mentioned, correctness, clarity, level fit, example used, and a **verbatim quote**. Code then applies it:
  - Proposals whose quote isn't in the segment are rejected.
  - A mention changes nothing. An incorrect explanation lowers mastery slightly.
  - Otherwise `gain = 28 × correctness × clarity × level-fit × example bonus × prerequisite factor × learn rate × (100 − mastery)/100`, which gives diminishing returns.
  - An active misconception caps the concept at 55, and a partially addressed one at 75.
  - Segment IDs are tracked, so the same segment never counts twice. A failed or missing response leaves the state untouched.
- **Misconceptions** change status only on an explicit, quote-backed `corrected` / `partially_corrected` / `reinforced` judgment, never because the concept was mentioned.

### How questions are chosen
`scoreCandidates()` scores every candidate. In priority order:
- An on-topic misconception the student hasn't voiced yet (2.2)
- A follow-up to a partly answered question (1.7)
- A prerequisite gap: the teacher is building on something below 35 mastery (1.4+)
- A concept that was mentioned but not explained (1.1)
- A concept that was explained but isn't landing (0.6)
- Low mastery in general
- An advanced-level challenge (0.9)
- Curiosity about the next concept (0.5)

**Specific, not vague.** When an explanation doesn't fully land, the evaluator records the exact question a learner would still have, grounded in the teacher's words (e.g. *"If gravity pulls the planets in, why don't they fall into the Sun?"*). Code stores it on the concept as an open gap. A clear, correct explanation, or a full answer to the student's question, closes it; a mere mention doesn't. Candidates with a known gap get +0.45, concepts from the most recent segment get +0.3, and a "clarify" with no specific target gets −0.35. `/api/speak` then checks the phrased line shares content words with the target and isn't a stock vague phrase (`lib/student/dialogue.ts`). If not, it retries once, then falls back to the recorded question verbatim. Gaps still open at the end become feedback evidence.

Concepts asked about in the last two questions are penalized, and anything already answered well is excluded. A small seeded random bonus adds natural variety. The question type depends on the level: a kindergartner asks what a word means, a high schooler asks how two concepts relate, and an expert challenges. The policy never asks while the student is talking, during a per-level cooldown, or while waiting for an answer. Confusion shortens the cooldown, and a 75s monologue lowers the threshold for checking in.

### How speech is measured
Each final recognition result is timestamped on the client: start is when the recognizer first reported it, end is when it became final. Student lines are timed from text-to-speech start and end events. WPM uses only utterances with a measured duration (typed text is excluded), and is shown only after 15s or more of timed speech. Other measures: pauses of 4s or more, runs of continuous speech (gaps under 4s with no student turn between), response latency after student questions, and filler words (um/uh/you know/I mean, plus "like" only in filler positions, so "it's like a kitchen" doesn't count). All of these are approximate. Chrome often drops "um", so filler counts are a lower bound.

## Testing

```bash
npm test                    # 52 unit tests for all deterministic logic (node:test)
npm run typecheck           # tsc --strict on the TypeScript modules
bash tests/routes/run.sh    # real API route handlers with stubbed Next + SDK
bash tests/browser/run.sh   # real UI in headless Chromium, simulated mic/TTS/API
```

The browser test walks a full session: start, teach, student voices a misconception, mic pauses so its voice isn't transcribed, the teacher corrects it, the misconception resolves, end, evidence-cited feedback, reload, history restore.

### Manual test script
1. Topic **Photosynthesis**, level **Middle schooler**, 2 min. Optionally upload `samples/photosynthesis_notes.pdf`. Start.
2. Say: "Plants make their own food from sunlight." The student should push back with a misconception, something like soil or dirt. Open **Student understanding** to see it.
3. Correct it directly, for example "No, the soil only gives water and minerals; the food is sugar made in the leaves." The misconception should show **resolved** and mastery should rise.
4. Use a term like "thylakoid" without defining it. The student should look confused or ask what it means.
5. Talk for more than 90s without pausing, then end. Feedback should cite the moment with a timestamp, and **How you spoke** should show the long stretch.

## Customizing the avatar
`components/Avatar.js` is a placeholder. Keep its props (`behavior`, `speaking`, `thinking`, `level`) and swap the SVG for images, Lottie or Rive. The expressions live in the "Avatar" block of `app/globals.css`.

## Limitations
- Mastery numbers are a **simulation**, not a measurement of learning.
- Speech recognition is Chrome-first and English. Timing comes from recognition events, not raw audio.
- The quality of observations and questions depends on the LLM. The code guards structure and evidence, not judgment.
- History lives in one browser's localStorage, and uploaded files aren't saved.

# teach2learn

Two complementary modes, one voice conversation with a simulated student:

- **Learn to Teach — Educator.** Become a better educator. Review a checklist of the key ideas, then teach a realistic student; it asks real questions, holds a misconception or two, and has to show it understood. You get an overall score and three category scores out of 100, three lines of feedback, and a practice challenge from a coach that tracks you across sessions.
- **Teach to Learn — Student.** Master concepts by explaining them. Review a short checklist of the key ideas, then explain them to a curious student whose questions expose gaps in your own understanding. Optional whiteboard. Content-only feedback: what you got right, gaps, misconceptions, what to review next.
- **L2T Daily.** Everyone teaches the same subject to the same student each day, scored out of 100 on the server, with a shared leaderboard.

## Run it

Needs Node 22.6+ and Chrome.

```bash
npm install
cp .env.example .env.local   # add ANTHROPIC_API_KEY (and ELEVENLABS_API_KEY for the natural voice)
npm run dev                  # http://localhost:3000, allow the microphone
```

No mic? Type into the box under the transcript.

## How a session works

```
teacher speaks ─► final transcript ─► 0.8s pause = end of turn
                                          │
                       decideTurn()  (deterministic: answer / ask / acknowledge / explain back / stay quiet)
                                          │
                       /api/reply  (streamed; sees exactly what you just said + what the student knows)
                                          │ first sentence
                       voice  (ElevenLabs Flash v2.5, or the best browser voice) ─► mic paused while it talks
background, never blocking:  /api/evaluate → knowledge model     /api/verify → learning verification
```

- **Fast path.** The reply starts at your pause, not after a word count, and doesn't wait for the knowledge evaluation. If you start talking again before its audio begins, the reply is dropped. Every reply responds to your latest words.
- **Student behavior.** A middle schooler reasons competently and learns from clear explanations. The levels differ in vocabulary and background knowledge. On each turn the student does one of these:
  - answers when you ask it something
  - asks about a real gap or a misconception
  - reacts to your answer to its question
  - briefly acknowledges and lets you continue
  - stays quiet
- **Knowledge model** (`lib/student/`). The student starts from the concepts on your checklist. Misconceptions persist until explicitly corrected. The model feeds the reply prompt as what the student "knows", so its replies change as it learns.

### How learning is verified
Explained is not the same as understood. Near the end (after about 55% of the time), or when you ask "does that make sense?", the student explains a taught concept back in its own words, using only what you told it. On a second try, it applies the concept to a new example. Answers to your questions count too. `/api/verify` grades the statement against the concept's correct description, and code applies the result:
- **Demonstrated understanding**: the verifier says demonstrated *and* you had actually taught the concept.
- **Partially understood**: the explanation was partly right.
- **Not yet verified**: there was no demonstration, or it was wrong. The result notes whether you explained it but it wasn't shown back.

A failed attempt never upgrades the status, and mastery numbers are never shown as grades.

### Feedback
There are exactly three items about your teaching (**What went well / What to improve / Try next time**). Each one cites a timestamped piece of transcript evidence from the session; code rejects citations that don't exist or are of the wrong kind, and falls back to a deterministic choice. The concept summary uses only the three labels above. Teaching feedback and student learning are kept separate.

### Scores (Learn to Teach)
Each category is 0–100 (or **Not enough evidence**), computed by fixed, weighted criteria in `lib/coach/rubric.ts` from measured session evidence (no LLM), so the same session always gets the same scores. **Overall = 30% Engagement + 30% Communication + 40% Teaching effectiveness.** A criterion that can't be judged in a session (e.g. the student asked no questions) is marked n/a and its weight is spread over the others; a category with less than 40 points of judgeable criteria isn't rated.

| Category | Criteria (points) |
|---|---|
| Engagement | Checked understanding (25: none 0, once 70%, twice+ full) · Answered the student's questions (35: share answered, partial = half) · Let the student take part (25: longest stretch ≤60s full, 60–90s 60%, >90s 20%) · Responded to wrong ideas the student voiced (15) |
| Communication | Clear explanations (40: share the student could follow) · Level-appropriate language (25: unexplained terms *beyond the student's level*: 0 full, then 80/60/40%) · Logical order (20: ideas explained after what they build on) · Pace and fluency (15: only when measured) |
| Teaching effectiveness | Accuracy (30: −40% per factual error or agreeing with a wrong idea) · Explained the why (25: share of accurate explanations that covered the essential idea and its reason) · Covered the key ideas (15) · Student showed understanding (20: one concept 70% + share demonstrated) · Fixed wrong ideas (10) |

Fairness rules: students know their level's vocabulary and prerequisites (`knows` in `lib/levels.ts`), and code never counts those words as jargon; concise, accurate explanations get full marks (length earns nothing); any factual error is "incorrect" and accurate-but-shallow explanations are tracked separately; pauses, accents and speaking style are never inputs. Under 40 words from the tutor → "Not enough evidence". Scores saved under the old 1–5 rubric are recomputed from the saved session data.

### The coach (LangChain Deep Agents)
After feedback is shown, the browser posts the session to `/api/coach`. It never runs during a live session.

- **Agent:** `createDeepAgent` from `deepagents` with `ChatAnthropic` (`SMART_MODEL`), our tools, and a system prompt that states objectives and conditional rules rather than a fixed call order (`lib/coach/agent.ts`). The agent plans with Deep Agents' built-in `write_todos`; subagents and files aren't needed and the prompt says so.
- **Tools** (`lib/coach/tools.ts`, plain functions so they're testable): `get_session_overview`, `get_transcript_evidence`, `calculate_speech_statistics`, `score_session` (the deterministic rubric), `get_previous_sessions`, `compare_with_previous` (trends, recurring skills, ranked focus candidates), `check_previous_challenge` (offered only when the session attempted one), `save_evaluation` (one focus skill + evidence ids + a note to itself for next time), `save_practice_challenge` (new scenario + 1–3 measurable criteria, or `retry_previous`). Tools validate everything and return `{"error": …}` with a fix hint, so the agent can correct itself.
- **Loop across sessions:** investigate → analyze → verify the last challenge → compare with history → diagnose one skill → plan a challenge → save it. The next session launched from **Next challenge** carries the challenge id; the coach then checks the same criteria, marks it met / partly / not met / not enough evidence, and retries, levels up or moves on.
- **Fallbacks:** no API key, `deepagents` not installed, an API error or a 75s timeout → the deterministic coach (`lib/coach/fallback.ts`) runs the same tools with fixed rules. If the agent stops before saving, the missing steps are completed the same way. If `/api/coach` itself is unreachable, the browser runs the deterministic coach locally.
- **Developer log:** every step, tool call (args, short result, ms), decision and error is printed as `[coach] …` on the server (`COACH_LOG=off` to silence) and shown under **Progress → Coach activity**. The model's own text is never logged.

### Practice challenges and progress
A challenge (`lib/coach/challenges.ts`) has a skill, a goal shown during the session, a student profile the simulated student plays, an optional starting misconception, and criteria over fixed metrics (check-ins, longest stretch, questions answered, unexplained terms, unclear/incorrect explanations, misconceptions resolved, concepts demonstrated, ratings). Criteria are measured with the same facts as the ratings, so attempts are comparable. Difficulty goes up after a fully met attempt and down after a missed one.

`lib/progress.ts` keeps, per browser: each session's date, topic, level, ratings, speech metrics, feedback, end-of-session student state and the coach's focus; the challenges with every attempt; and the last coach log. Sessions saved before this existed are added from their saved data. Unmeasured values stay empty (gaps in the chart), never estimated. **Progress** shows the three ratings over time (with a table view), the current challenge and how attempts compare, recurring areas (in ≥2 of the last 5 rated sessions: improving / still showing up), and recent sessions.

## Concept checklist (both modes)
Both modes start with a 5–10 concept checklist, prerequisites first, from the topic or uploaded notes (notes win). You can rename, add, remove and reorder before starting; it then stays beside the conversation with your own ticks kept separate from the tracked status (Learn to Teach: what the student has learned; Teach to Learn: what you've shown you understand). Only names are shown, never the answers.

It's built in two stages so it appears quickly: `/api/prepare` with `stage: 'outline'` asks the fast model for just the names (small output), and the checklist shows as soon as that returns. Then `stage: 'details'` asks the smart model, in the background while you review, for what each explanation must establish, key terms and the student's misconceptions (including a coach challenge's misconception). Details merge by concept id, so your edits still apply; if they fail, explanations are judged against general knowledge of the topic. L2T Daily skips the checklist (its concepts are fixed).

## Teach to Learn
1. **Checklist.** See above.
2. **Session.** Same voice, avatar, turn-taking and background evaluation as Learn to Teach (`SessionEngine` with `mode: 'student'`). Code picks each question (`lib/learner/probes.ts`): clear up an unreadable drawing → question an error you made (without correcting you) → follow up on a half-answered question → the student's own misconception → your drawing → probe the concept you're on one level deeper (what → why/how → connections/assumptions → a new case) → a skipped prerequisite → curiosity about the next item. Depth rises when you answer well and drops after an error. The reply prompt keeps it a curious student, never an examiner, and never gives answers.
3. **Live checklist** (`lib/learner/tracker.ts`): Not covered → Discussed → Demonstrated. Demonstrated needs an accurate explanation **and** a follow-up question answered fully and correctly, with no error left uncorrected. Your own checkmarks are separate.
4. **Whiteboard** (optional): pen, eraser, colours, undo/redo, clear; mouse, touch or stylus. A snapshot is read by a vision model (`/api/whiteboard`) only when you press **Show the student**, after you stop drawing for 3.5s (at most every 12s, only if it changed), or at the end. What it reads is evaluated exactly like speech, so it counts on the checklist; the student can ask about it; anything it can't read becomes a question instead of a guess.
5. **Feedback** (`/api/study-feedback`): correct understanding, knowledge gaps, misconceptions (quoted), what to review next, plus each concept as Demonstrated / Partial / Not yet verified. No delivery metrics, scores or percentages. Citations are checked; deterministic fallback.
6. **Study planner** (`/api/study-plan`, Deep Agents, separate from the coach): tools `get_session_overview`, `get_concept_evidence`, `get_whiteboard_evidence`, `search_material`, `get_previous_study_sessions`, `rank_knowledge_gaps`, `save_gap_analysis` (misconceptions must quote your exact words), `save_practice` (must not contain the answer). **Retry this explanation** opens a new session where the student starts with that question. Deterministic fallback as for the coach.
7. **Progress** is stored separately (`lib/study/progress.ts`): topics, latest status per concept, remaining gaps, practice attempts. Progress and History have a Learn to Teach / Teach to Learn switch.

## L2T Daily
- **Same for everyone:** `lib/daily/schedule.ts` picks the day's challenge from a fixed list by UTC date (rotates; resets at midnight UTC). Each has a fixed topic, level, three objectives and a fixed concept list with the student's misconceptions, so every attempt starts from the same student knowledge. Sessions are normal Learn to Teach sessions (student questions can't be turned off) scored with the standard rubric.
- **Server-side scoring:** `/api/daily/start` issues an HMAC-signed, single-use attempt token and a signed anonymous user id (the username is just a display name). During the session, `/api/evaluate`, `/api/reply` and `/api/verify` record what the server itself produced for that token. `/api/daily/submit` rebuilds the student model from those records, keeps only transcript lines that match what the server evaluated or what the student said, and computes the score. The client never sends a score. Also: time checks (≥45s, within the time limit + 15 min), 15 attempts per user per day, 80 recorded events per attempt.
- **Leaderboard:** best eligible attempt per user per day, ranked by score then time. Storage: Redis over REST if `UPSTASH_REDIS_REST_URL/_TOKEN` (or Vercel KV's `KV_REST_API_URL/_TOKEN`) are set; otherwise a JSON file on the server (`DAILY_DATA_FILE`). **For a deployed, multi-instance app, set the Redis variables.**

### Voice
- **ElevenLabs Flash v2.5** (set `ELEVENLABS_API_KEY`): proxied through `/api/tts`, which keeps the key on the server. Each sentence's audio is fetched as soon as the sentence is written and played back-to-back.
- **Fallback:** the most natural local voice (Edge "Natural/Online", Google, Premium/Enhanced voices) with age-tuned pitch and rate. Previously the app used the default robotic browser voice.

## Code map

| Area | File |
|---|---|
| Turn-taking decisions | `lib/student/turns.ts` |
| Live orchestration | `lib/student/engine.ts` (`SessionEngine`) |
| Knowledge model + verification rules | `lib/student/knowledge.ts`, `misconceptions.ts` |
| Question selection, specificity | `lib/student/questions.ts`, `dialogue.ts` |
| What the student "knows" (prompt) | `lib/student/persona.ts` |
| Streaming text → sentences | `lib/student/sentences.ts` |
| Speech metrics, evidence + feedback | `lib/student/speech.ts`, `evidence.ts` |
| Prompts | `lib/prompts.js` |
| Routes | `app/api/{prepare,evaluate,reply,verify,tts,feedback,coach}`; Teach to Learn `whiteboard`, `study-feedback`, `study-plan`; Daily `daily`, `daily/start`, `daily/submit` |
| Teach to Learn | `lib/learner/*` (checklist, tracker, probes, feedback, whiteboard, prompts), `lib/study/*` (planner, progress) |
| L2T Daily | `lib/daily/*` (schedule, service, store, record) |
| Ratings rubric | `lib/coach/rubric.ts` |
| Coach: tools, agent, fallback | `lib/coach/tools.ts`, `agent.ts`, `fallback.ts` |
| Challenges + criteria | `lib/coach/challenges.ts` |
| Tutor progress (localStorage) | `lib/progress.ts`, `lib/coach/record.ts` |
| Voice playback | `lib/voice.js` |
| UI | `components/` (incl. `ProgressScreen.js`, `ChecklistScreen.js`, `ConceptChecklist.js`, `Whiteboard.js`, `StudyResults.js`, `StudyProgress.js`, `DailyScreen.js`), `app/globals.css` |
| Persistence (localStorage, v4 + migration) | `lib/history.ts` |

## Avatar
Each level can have its own character: put its frames in `public/avatar/<level>/` (kindergarten, middle, high, college, expert) and list them in that folder's `avatar.json`. Levels without their own art use the shared character in `public/avatar/`. `public/avatar/README.md` has the frame list and export specs.
- **Frames:** `listening` (required), `listening-blink`, `curious`, `confused`, `understanding`, `challenging`, `talking-1`, `talking-2`.
- **Fallbacks:** a missing expression shows that character's `listening` frame (characters are never mixed). With no art at all, the built-in placeholder face is used, so frames can be added one at a time.
- **Animation:** talking frames alternate while the student's voice plays, and the blink frame flashes every few seconds.
- **Code:** frame selection is in `lib/avatar.js`, the component in `components/Avatar.js`. The rest of the app only passes `behavior`, `speaking`, `thinking` and `level`.

## Testing

```bash
npm test                    # unit + engine tests (node:test)
npm run typecheck
bash tests/routes/run.sh    # real route handlers with stubbed Next/SDK/ElevenLabs (incl. Daily with a file store)
bash tests/browser/run.sh   # real UI in headless Chromium: Learn to Teach, Teach to Learn, L2T Daily
```

### Manual test (needs real keys, Chrome, and a mic)
1. Topic "Photosynthesis", Middle schooler, 2 min.
2. Say "plants make their own food from sunlight". The student should push back with its misconception within about 2 seconds.
3. Correct it ("no, the soil only gives water…"). The student should react to your answer, and the panel should show **Corrected**.
4. Ask "does that make sense?" The student should explain it back, and the panel should show **Demonstrated** if the explanation was right.
5. Use an undefined term ("thylakoid"), then end the session. **What to improve** should cite that moment, and Communication should lose a few points (see "Evidence and how ratings work").
6. Within a few seconds the **Next challenge** card should fill in. The server log shows `[coach] … step agent: Deep Agents run started` if the agent ran, or `fallback` and the reason if it didn't.
7. Start the challenge, then check that its result appears on the next results page and in **Progress**.

## Limitations
- Measured latency (below) uses simulated API timings. Real latency also includes Chrome's speech finalization (~0.5s) and network.
- Speech recognition is Chrome-first and English. Pauses, fillers and pace come from recognition events.
- Mastery and verification are simulated estimates, not measurements of learning.
- History and progress are per-browser (localStorage). The L2T Daily leaderboard is server-side.
- L2T Daily anti-cheat is basic: someone can still type or script good explanations into the live session (typing is allowed by design), and a reply that the client replaces with its built-in fallback line isn't recorded server-side. Usernames aren't unique or moderated.
- The whiteboard, the Teach to Learn student and the study planner have only been tested with stand-ins for the models.
- The Learn to Teach coach's Deep Agents run has worked with the real packages. The Teach to Learn study planner uses the same runtime but has only been tested with a stand-in agent so far.
- Production builds (`next build`) haven't been run in the development sandbox (no package installs there); run one before deploying.

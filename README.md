# teach2learn

Learn it by teaching it. Pick a topic (optionally upload notes), choose who you're teaching, press **Start session** and explain it out loud for about two minutes. A simulated student listens, asks real questions, holds a misconception or two, and has to show it understood. Then you get three 1–5 ratings, three lines of feedback, a summary of what the student actually demonstrated, and a practice challenge from a coach that tracks you across sessions. Think flight simulator for tutors.

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
- **Knowledge model** (`lib/student/`). Each session covers 1–3 key concepts. Misconceptions persist until explicitly corrected. The model feeds the reply prompt as what the student "knows", so its replies change as it learns.

### How learning is verified
Explained is not the same as understood. Near the end (after about 55% of the time), or when you ask "does that make sense?", the student explains a taught concept back in its own words, using only what you told it. On a second try, it applies the concept to a new example. Answers to your questions count too. `/api/verify` grades the statement against the concept's correct description, and code applies the result:
- **Demonstrated understanding**: the verifier says demonstrated *and* you had actually taught the concept.
- **Partially understood**: the explanation was partly right.
- **Not yet verified**: there was no demonstration, or it was wrong. The result notes whether you explained it but it wasn't shown back.

A failed attempt never upgrades the status, and mastery numbers are never shown as grades.

### Feedback
There are exactly three items about your teaching (**What went well / What to improve / Try next time**). Each one cites a timestamped piece of transcript evidence from the session; code rejects citations that don't exist or are of the wrong kind, and falls back to a deterministic choice. The concept summary uses only the three labels above. Teaching feedback and student learning are kept separate.

### Ratings
Three categories, each 1–5 or **Not enough evidence**, computed by fixed rules in `lib/coach/rubric.ts` (no LLM), so the same session always gets the same score and sessions are comparable. Each rating shows one explanation (the factor that decided it) and the evidence behind it.

| Category | Starts at | Moves when |
|---|---|---|
| Engagement | 3 | +1 you checked understanding / asked the student to think (once is enough; more isn't rewarded) · +1 answered ≥75% of its questions, −1 under 50% · −1 a 90s+ stretch with no check-in · −1 the student never got to take part |
| Communication | 4 | −1 per unexplained term (max −2) · −1 an unclear/over-level explanation (−2 for 3+) · −1 very frequent fillers or very fast pace, **only when measured** · +1 everything explained was clear |
| Teaching effectiveness | 3 | −1 per inaccurate explanation (max −2) · +1 the student demonstrated a concept · +1 a misconception resolved, −1 one it voiced left standing · −1 nothing actually explained · +1 a concrete example · **capped at 4 without a demonstration** (explaining ≠ learning) |

Under 40 words from the tutor → every category is "Not enough evidence"; Teaching also needs the topic's concepts to come up. Pauses, accents and speaking style are never inputs.

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
| Routes | `app/api/{prepare,evaluate,reply,verify,tts,feedback,coach}` |
| Ratings rubric | `lib/coach/rubric.ts` |
| Coach: tools, agent, fallback | `lib/coach/tools.ts`, `agent.ts`, `fallback.ts` |
| Challenges + criteria | `lib/coach/challenges.ts` |
| Tutor progress (localStorage) | `lib/progress.ts`, `lib/coach/record.ts` |
| Voice playback | `lib/voice.js` |
| UI | `components/` (incl. `ProgressScreen.js`), `app/globals.css` |
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
bash tests/routes/run.sh    # real route handlers with stubbed Next/SDK/ElevenLabs
bash tests/browser/run.sh   # real UI in headless Chromium with simulated mic/voice/API (+ latency)
```

### Manual test (needs real keys, Chrome, and a mic)
1. Topic "Photosynthesis", Middle schooler, 2 min.
2. Say "plants make their own food from sunlight". The student should push back with its misconception within about 2 seconds.
3. Correct it ("no, the soil only gives water…"). The student should react to your answer, and the panel should show **Corrected**.
4. Ask "does that make sense?" The student should explain it back, and the panel should show **Demonstrated** if the explanation was right.
5. Use an undefined term ("thylakoid"), then end the session. **What to improve** should cite that moment, and Communication should be 3/5.
6. Within a few seconds the **Next challenge** card should fill in. The server log shows `[coach] … step agent: Deep Agents run started` if the agent ran, or `fallback` and the reason if it didn't.
7. Start the challenge, then check that its result appears on the next results page and in **Progress**.

## Limitations
- Measured latency (below) uses simulated API timings. Real latency also includes Chrome's speech finalization (~0.5s) and network.
- Speech recognition is Chrome-first and English. Pauses, fillers and pace come from recognition events.
- Mastery and verification are simulated estimates, not measurements of learning.
- History and progress are per-browser (localStorage).
- The Deep Agents path was built against the documented `deepagents` / `langchain` JS API but has not been run against the real packages and model yet; it's covered by tests with a stand-in agent. The deterministic coach is fully tested.

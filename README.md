# teach2learn

Learn it by teaching it. Pick a topic (optionally upload notes), choose who you're teaching, press **Start session** and explain it out loud for about two minutes. A simulated student listens, asks real questions, holds a misconception or two, and has to show it understood. Then you get three lines of feedback and a summary of what the student actually demonstrated.

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
| Routes | `app/api/{prepare,evaluate,reply,verify,tts,feedback}` |
| Voice playback | `lib/voice.js` |
| UI | `components/`, `app/globals.css` |
| Persistence (localStorage, v4 + migration) | `lib/history.ts` |

## Avatar
`components/Avatar.js` is a placeholder. Keep its props (`behavior`, `speaking`, `thinking`) and swap in your art: one image per behavior plus a talking loop, or Lottie/Rive. Expressions are in the Avatar block of `app/globals.css`.

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
5. Use an undefined term ("thylakoid"), then end the session. **What to improve** should cite that moment.

## Limitations
- Measured latency (below) uses simulated API timings. Real latency also includes Chrome's speech finalization (~0.5s) and network.
- Speech recognition is Chrome-first and English. Pauses, fillers and pace come from recognition events.
- Mastery and verification are simulated estimates, not measurements of learning.
- History is per-browser (localStorage).

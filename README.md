# teach2learn

Learn it by teaching it. Upload your material, pick who you're teaching (kindergartner → expert), and explain it out loud before the timer runs out. An AI learner takes notes as you talk, then its notebook is graded against a rubric built only from your material.

## Run it (5 minutes)

1. Install [Node.js](https://nodejs.org) 20 or newer.
2. In this folder:
   ```bash
   npm install
   cp .env.example .env.local     # then paste your Anthropic API key into .env.local
   npm run dev
   ```
3. Open **http://localhost:3000 in Chrome** and allow the microphone.

No mic, or not on Chrome? Use the **"Type instead"** box on the session screen. It's also the fastest way to test without talking.

### Deploy for judges
```bash
npx vercel
```
Then add `ANTHROPIC_API_KEY` under Project → Settings → Environment Variables and redeploy. The mic only works over HTTPS (Vercel gives you that) or on localhost.

## How it works

```
Setup ──► /api/prepare ──► Overview + rubric ──► Session ──► /api/grade ──► Results
            (Sonnet)                               │            (Sonnet)
                                                   └─ every 15s ─► /api/notes (Haiku)
```

| Step | What happens | Honesty guardrail |
|---|---|---|
| **Prepare** | Reads your files (PDFs go to Claude directly, no text extraction) and returns an overview, every concept, and a level-specific rubric | Every item must quote the source. For text sources, code checks the quote really exists and drops anything that doesn't (`lib/verify.js`) |
| **Notes** | Browser speech-to-text → every ~15s the new speech goes to the note-taker, playing the chosen learner | It **never sees the rubric or source**, so it can't fill in what you "should" have said. It writes `😕 Lost me` when you use something above the learner's level |
| **Grade** | Rubric + notebook + transcript → met / partial / missing, misconceptions, outside knowledge, tips | Credit requires a quote from your transcript, and code checks it's really there (`lib/grading.js`). "Lost me"-only coverage counts as partial. Outside knowledge only counts if it's tied to a real concept from your material, and it never changes the score |

Scoring: met = 1, partial = ½, missing = 0. The rubric is the same no matter how much time you pick.

## Where things live

```
lib/prompts.js     ← ALL three prompts + their JSON schemas (tune here)
lib/levels.js      ← the 5 learner levels (what they understand, what loses them, rubric size)
lib/verify.js      ← quote checking + dropping unsourced rubric items
lib/grading.js     ← turns the model's grading into the final, code-checked result
lib/claude.js      ← API calls (forced tool use = guaranteed JSON); model names
app/api/*          ← the three endpoints
components/        ← the four screens: Setup, Overview, Session, Results
app/globals.css    ← all styling
```

Models: Sonnet for prep and grading, Haiku for the live note-taker. Change them in `.env.local` with `SMART_MODEL` / `FAST_MODEL`.

## Splitting the work

- **Prompts person:** `lib/prompts.js` + `lib/levels.js`. Run the same lesson at different levels and tune until the notes and grades feel fair.
- **Frontend person:** `components/` + `globals.css`.
- **Demo person:** pick the sample material, write the script, deploy to Vercel, and test on the actual demo laptop and mic.

## Known limits

- Upload types: PDF, TXT, MD, images. Export slides or Word docs to PDF first. Keep uploads under 3 MB total (Vercel's request limit).
- Quote checking runs on text sources only. For PDFs, the source quotes come from the model unchecked (the grading-side transcript checks still apply).
- Speech recognition is Chrome-first and English (`rec.lang` in `SessionScreen.js`).
- Nothing is saved: refreshing the page clears everything.

## Stretch goals

- Learner asks one question at the end about its biggest "lost me" moment
- Save attempts to localStorage to show progress across sessions
- Extract text from PDFs in the browser (pdf.js) so PDF quotes can be checked too

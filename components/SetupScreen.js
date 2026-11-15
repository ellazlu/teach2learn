'use client';

import { useState } from 'react';
import { LEVELS } from '../lib/levels.ts';
import { MODE_NAME, MODE_ROLE } from '../lib/learner/types.ts';

const MODES = [
  { id: 'educator', blurb: 'Practice teaching a realistic student and receive feedback on your teaching skills.' },
  { id: 'student', blurb: 'Master academic concepts by teaching them to an AI student who challenges your understanding.' },
];

const TIME_PRESETS = [1, 2, 3, 5]; // minutes
const MAX_TOTAL_BYTES = 3 * 1024 * 1024; // keeps requests under Vercel's 4.5 MB body limit
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function readFile(file) {
  return new Promise((resolve, reject) => {
    const lower = file.name.toLowerCase();
    const isPdf = file.type === 'application/pdf' || lower.endsWith('.pdf');
    const isImage = IMAGE_TYPES.includes(file.type);
    const isText = file.type.startsWith('text/') || /\.(txt|md|markdown)$/.test(lower);
    if (!isPdf && !isImage && !isText) {
      reject(new Error(`${file.name}: unsupported file type. Use PDF, TXT, MD, or an image (export slides/Word docs to PDF).`));
      return;
    }
    const r = new FileReader();
    r.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    if (isText) {
      r.onload = () => resolve({ name: file.name, kind: 'text', data: String(r.result), size: file.size });
      r.readAsText(file);
    } else {
      r.onload = () => {
        const url = String(r.result);
        resolve({
          name: file.name,
          kind: isPdf ? 'pdf' : 'image',
          mediaType: isPdf ? 'application/pdf' : file.type,
          data: url.slice(url.indexOf(',') + 1),
          size: file.size,
        });
      };
      r.readAsDataURL(file);
    }
  });
}

export default function SetupScreen({ initial, error, onSubmit, mode = 'educator', onModeChange = () => {} }) {
  const study = mode === 'student';
  const initialFiles = (initial?.sources || []).filter((s) => s.name !== 'Pasted text');
  const initialPaste = initial?.sources?.find((s) => s.name === 'Pasted text')?.data || '';
  const initialMin = initial ? initial.timeLimitSec / 60 : 5; // a 5-10 concept checklist needs a few minutes

  const [files, setFiles] = useState(initialFiles);
  const [pasted, setPasted] = useState(initialPaste);
  const [topic, setTopic] = useState(initial?.topic || '');
  const [focus, setFocus] = useState(initial?.focus || '');
  const [levelId, setLevelId] = useState(initial?.levelId || 'middle');
  const [minutes, setMinutes] = useState(initialMin);
  const [customMin, setCustomMin] = useState(TIME_PRESETS.includes(initialMin) ? '' : String(initialMin));
  const [localError, setLocalError] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);

  async function addFiles(e) {
    setLocalError('');
    const picked = Array.from(e.target.files || []);
    e.target.value = '';
    try {
      const read = await Promise.all(picked.map(readFile));
      setFiles((f) => [...f.filter((x) => !read.some((r) => r.name === x.name)), ...read]);
    } catch (err) {
      setLocalError(err.message);
    }
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0) + pasted.length;
  const effectiveMin = customMin ? Number(customMin) : minutes;
  const canSubmit = (topic.trim() || files.length > 0 || pasted.trim()) && effectiveMin > 0 && totalBytes <= MAX_TOTAL_BYTES;

  function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    const sources = [...files];
    if (pasted.trim()) sources.push({ name: 'Pasted text', kind: 'text', data: pasted.trim(), size: pasted.length });
    onSubmit({ sources, topic: topic.trim(), levelId, focus, timeLimitSec: Math.round(effectiveMin * 60), mode });
  }

  function pickMode(m) {
    if (m !== mode) onModeChange(m);
  }

  const showNotes = notesOpen || files.length > 0 || pasted.trim();

  return (
    <form className="setup" onSubmit={submit}>
      <div className="mode-pick" role="radiogroup" aria-label="Mode">
        {MODES.map((m) => (
          <button type="button" role="radio" aria-checked={mode === m.id} key={m.id} className={`mode-option ${mode === m.id ? 'on' : ''}`} onClick={() => pickMode(m.id)}>
            <span className="mode-name">{MODE_NAME[m.id]} <span className="mode-role">— {MODE_ROLE[m.id]}</span></span>
            <span className="mode-blurb">{m.blurb}</span>
          </button>
        ))}
      </div>

      {study ? (
        <header className="setup-head">
          <h1>Master concepts by explaining them.</h1>
          <p className="muted">Pick what you're studying. You'll get a short checklist of the key ideas to review, then explain them out loud to a curious student whose questions show you what you really understand.</p>
        </header>
      ) : (
        <header className="setup-head">
          <h1>Become a better educator.</h1>
          <p className="muted">Pick a topic and review the checklist of key ideas, then teach them out loud to a simulated student. It asks questions, holds a few misconceptions, and has to show it understood.</p>
        </header>
      )}

      <div className="field">
        <label className="label" htmlFor="topic">Topic</label>
        <input id="topic" className="input topic-input" placeholder="e.g. Photosynthesis, Newton's first law" value={topic} onChange={(e) => setTopic(e.target.value)} autoFocus />
        {!showNotes ? (
          <button type="button" className="btn-text small" onClick={() => setNotesOpen(true)}>+ Add notes or slides (optional)</button>
        ) : (
          <div className="notes">
            <p className="muted small">{study ? 'Your checklist, the questions and your feedback will stick to what is in your notes.' : "The student's concepts and your feedback will stick to what's in your notes."}</p>
            <label className="file-pick">
              <input type="file" multiple accept=".pdf,.txt,.md,.markdown,image/*" onChange={addFiles} />
              <span>Choose files</span>
              <span className="muted small">PDF, TXT, MD or images · up to 3 MB</span>
            </label>
            {files.length > 0 && (
              <ul className="file-list">
                {files.map((f) => (
                  <li key={f.name}>
                    <span>{f.name}</span>
                    <button type="button" className="btn-text small" onClick={() => setFiles(files.filter((x) => x !== f))}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
            <textarea className="input" placeholder="…or paste notes" rows={3} value={pasted} onChange={(e) => setPasted(e.target.value)} />
            <input className="input" placeholder="Focus (optional), e.g. “only section 2”" value={focus} onChange={(e) => setFocus(e.target.value)} />
            {totalBytes > MAX_TOTAL_BYTES && <p className="error small">Files are over 3 MB total.</p>}
          </div>
        )}
      </div>

      <div className="field">
        <span className="label" id="level-label">{study ? 'Explain it to' : 'Student'}</span>
        <div className="segmented" role="radiogroup" aria-labelledby="level-label">
          {LEVELS.map((l) => (
            <button type="button" role="radio" aria-checked={levelId === l.id} key={l.id} className={levelId === l.id ? 'on' : ''} onClick={() => setLevelId(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="label" id="time-label">Time</span>
        <div className="segmented compact" role="radiogroup" aria-labelledby="time-label">
          {TIME_PRESETS.map((m) => (
            <button type="button" role="radio" aria-checked={!customMin && minutes === m} key={m} className={!customMin && minutes === m ? 'on' : ''} onClick={() => { setMinutes(m); setCustomMin(''); }}>
              {m} min
            </button>
          ))}
          <input className="custom-time" type="number" min="0.5" step="0.5" placeholder="Other" aria-label="Custom minutes" value={customMin} onChange={(e) => setCustomMin(e.target.value)} />
        </div>
      </div>

      {(error || localError) && <p className="error">{error || localError}</p>}

      <div className="setup-actions">
        <button className="btn primary large" type="submit" disabled={!canSubmit}>Build concept checklist</button>
        <span className="muted small">Uses your microphone (Chrome works best). You can also type.</span>
      </div>
    </form>
  );
}

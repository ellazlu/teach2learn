'use client';

import { useState } from 'react';
import { LEVELS } from '../lib/levels';

const TIME_PRESETS = [1, 2, 3, 5, 10]; // minutes
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

export default function SetupScreen({ initial, error, onSubmit }) {
  const initialFiles = (initial?.sources || []).filter((s) => s.name !== 'Pasted text');
  const initialPaste = initial?.sources?.find((s) => s.name === 'Pasted text')?.data || '';
  const initialMin = initial ? initial.timeLimitSec / 60 : 2;

  const [files, setFiles] = useState(initialFiles);
  const [pasted, setPasted] = useState(initialPaste);
  const [focus, setFocus] = useState(initial?.focus || '');
  const [levelId, setLevelId] = useState(initial?.levelId || 'middle');
  const [minutes, setMinutes] = useState(initialMin);
  const [customMin, setCustomMin] = useState(TIME_PRESETS.includes(initialMin) ? '' : String(initialMin));
  const [localError, setLocalError] = useState('');

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
  const canSubmit = (files.length > 0 || pasted.trim()) && effectiveMin > 0 && totalBytes <= MAX_TOTAL_BYTES;

  function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    const sources = [...files];
    if (pasted.trim()) sources.push({ name: 'Pasted text', kind: 'text', data: pasted.trim(), size: pasted.length });
    onSubmit({ sources, levelId, focus, timeLimitSec: Math.round(effectiveMin * 60) });
  }

  return (
    <form className="stack" onSubmit={submit}>
      <section className="card">
        <h2>1. What are you teaching?</h2>
        <p className="muted">Upload your class material. Everything the learner is graded on comes only from these files.</p>
        <label className="dropzone">
          <input type="file" multiple accept=".pdf,.txt,.md,.markdown,image/*" onChange={addFiles} />
          <span>📄 Click to add PDFs, text files, or images</span>
        </label>
        {files.length > 0 && (
          <ul className="file-list">
            {files.map((f) => (
              <li key={f.name}>
                <span>{f.name}</span>
                <button type="button" className="link" onClick={() => setFiles(files.filter((x) => x !== f))}>remove</button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          placeholder="…or paste notes / text here"
          rows={4}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
        />
        <input
          type="text"
          placeholder="Optional focus, e.g. “only section 2” or “skip the history part”"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
        />
        {totalBytes > MAX_TOTAL_BYTES && <p className="error">Files are over 3 MB total. Remove some or use smaller files.</p>}
      </section>

      <section className="card">
        <h2>2. Who are you teaching?</h2>
        <p className="muted">This sets how deep you need to go, and when your learner gets lost.</p>
        <div className="level-grid">
          {LEVELS.map((l) => (
            <button
              type="button"
              key={l.id}
              className={`level ${levelId === l.id ? 'selected' : ''}`}
              onClick={() => setLevelId(l.id)}
            >
              <span className="emoji">{l.emoji}</span>
              <span>{l.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>3. How long do you get?</h2>
        <div className="row">
          {TIME_PRESETS.map((m) => (
            <button
              type="button"
              key={m}
              className={`chip ${!customMin && minutes === m ? 'selected' : ''}`}
              onClick={() => { setMinutes(m); setCustomMin(''); }}
            >
              {m} min
            </button>
          ))}
          <input
            className="custom-time"
            type="number"
            min="0.5"
            step="0.5"
            placeholder="Custom min"
            value={customMin}
            onChange={(e) => setCustomMin(e.target.value)}
          />
        </div>
      </section>

      {(error || localError) && <p className="error">{error || localError}</p>}

      <button className="btn big" type="submit" disabled={!canSubmit}>Prepare my session →</button>
    </form>
  );
}

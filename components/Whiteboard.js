'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

// Teach to Learn: an optional whiteboard. Mouse, touch or stylus (Pointer
// Events), pen/eraser, a few colours, undo/redo, clear. It only draws; the
// session decides when a snapshot is read (share, pause after drawing, end).

const COLORS = [
  { id: 'ink', value: '#18181b', label: 'Black' },
  { id: 'blue', value: '#2a78d6', label: 'Blue' },
  { id: 'red', value: '#d03b3b', label: 'Red' },
  { id: 'green', value: '#1f8a5b', label: 'Green' },
];
const W = 1200; // logical canvas size; scaled to fit
const H = 675;

function drawStroke(ctx, s) {
  if (!s.points.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.tool === 'eraser' ? '#ffffff' : s.color;
  ctx.lineWidth = s.tool === 'eraser' ? 28 : 4;
  ctx.beginPath();
  ctx.moveTo(s.points[0][0], s.points[0][1]);
  if (s.points.length === 1) ctx.lineTo(s.points[0][0] + 0.1, s.points[0][1]);
  for (const [x, y] of s.points.slice(1)) ctx.lineTo(x, y);
  ctx.stroke();
  ctx.restore();
}

const Whiteboard = forwardRef(function Whiteboard({ onStrokeEnd, onShare, status, busy, disabled }, ref) {
  const canvasRef = useRef(null);
  const strokes = useRef([]);
  const redo = useRef([]);
  const current = useRef(null);
  const version = useRef(0);
  const [tool, setTool] = useState('pen');
  const [color, setColor] = useState(COLORS[0].value);
  const [, force] = useState(0);

  const redraw = () => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    for (const s of strokes.current) drawStroke(ctx, s);
  };
  useEffect(redraw, []);

  const changed = () => {
    version.current += 1;
    force((n) => n + 1);
  };

  const pos = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * W), Math.round(((e.clientY - r.top) / r.height) * H)];
  };

  function down(e) {
    if (disabled) return;
    e.preventDefault();
    canvasRef.current.setPointerCapture?.(e.pointerId);
    current.current = { tool, color, points: [pos(e)] };
    drawStroke(canvasRef.current.getContext('2d'), current.current);
  }
  function move(e) {
    if (!current.current) return;
    const p = pos(e);
    const s = current.current;
    s.points.push(p);
    const ctx = canvasRef.current.getContext('2d');
    drawStroke(ctx, { ...s, points: s.points.slice(-2) });
  }
  function up() {
    if (!current.current) return;
    strokes.current.push(current.current);
    current.current = null;
    redo.current = [];
    changed();
    onStrokeEnd?.();
  }

  const undo = () => {
    const s = strokes.current.pop();
    if (s) {
      redo.current.push(s);
      redraw();
      changed();
      onStrokeEnd?.();
    }
  };
  const doRedo = () => {
    const s = redo.current.pop();
    if (s) {
      strokes.current.push(s);
      redraw();
      changed();
      onStrokeEnd?.();
    }
  };
  const clear = () => {
    if (!strokes.current.length) return;
    redo.current = [...strokes.current].reverse();
    strokes.current = [];
    redraw();
    changed();
  };

  // Only pen strokes count as content; an erased-to-white board is blank.
  const isBlank = () => !strokes.current.some((s) => s.tool === 'pen');

  useImperativeHandle(ref, () => ({
    version: () => version.current,
    isBlank,
    // PNG for the vision model (downscaled), and a small JPEG thumbnail for history.
    snapshot(maxW = 1024) {
      const c = document.createElement('canvas');
      const scale = Math.min(1, maxW / W);
      c.width = Math.round(W * scale);
      c.height = Math.round(H * scale);
      const ctx = c.getContext('2d');
      ctx.drawImage(canvasRef.current, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/png');
      return url.slice(url.indexOf(',') + 1);
    },
    thumb(maxW = 240) {
      const c = document.createElement('canvas');
      c.width = maxW;
      c.height = Math.round((H / W) * maxW);
      c.getContext('2d').drawImage(canvasRef.current, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.6);
    },
  }));

  return (
    <div className="whiteboard">
      <div className="wb-tools" role="toolbar" aria-label="Whiteboard tools">
        <div className="segmented compact">
          <button type="button" className={tool === 'pen' ? 'on' : ''} aria-pressed={tool === 'pen'} onClick={() => setTool('pen')}>Pen</button>
          <button type="button" className={tool === 'eraser' ? 'on' : ''} aria-pressed={tool === 'eraser'} onClick={() => setTool('eraser')}>Eraser</button>
        </div>
        <div className="wb-colors">
          {COLORS.map((c) => (
            <button
              type="button"
              key={c.id}
              className={`wb-color ${color === c.value && tool === 'pen' ? 'on' : ''}`}
              style={{ background: c.value }}
              aria-label={c.label}
              aria-pressed={color === c.value}
              onClick={() => { setColor(c.value); setTool('pen'); }}
            />
          ))}
        </div>
        <div className="wb-edit">
          <button type="button" className="btn-text small" onClick={undo} disabled={!strokes.current.length}>Undo</button>
          <button type="button" className="btn-text small" onClick={doRedo} disabled={!redo.current.length}>Redo</button>
          <button type="button" className="btn-text small" onClick={clear} disabled={!strokes.current.length}>Clear</button>
        </div>
        <button type="button" className="btn small-btn" onClick={onShare} disabled={busy || disabled || isBlank()}>
          {busy ? 'Reading…' : 'Show the student'}
        </button>
      </div>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className={`wb-canvas ${tool === 'eraser' ? 'erasing' : ''}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={(e) => current.current && e.buttons === 0 && up()}
        aria-label="Whiteboard drawing area"
      />
      {status && <p className="wb-status muted small" aria-live="polite">{status}</p>}
    </div>
  );
});

export default Whiteboard;

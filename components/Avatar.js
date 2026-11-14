'use client';

import { useEffect, useState } from 'react';
import { loadFrames, pickFrame } from '../lib/avatar';

// The student avatar. Uses your hand-drawn frames from public/avatar/ (listed
// in public/avatar/avatar.json, see the README there); falls back to the
// built-in placeholder face until a `listening` frame exists.
//
// Props (the rest of the app only uses these):
//   behavior: 'listening' | 'curious' | 'confused' | 'understanding' | 'challenging' | 'responding'
//   speaking: true while the student's voice is playing (alternates talking frames)
//   thinking: true while the student is forming a reply

const LABELS = {
  listening: 'Listening',
  curious: 'Curious',
  confused: 'Confused',
  understanding: 'Getting it',
  challenging: 'Thinking it over',
  responding: 'Speaking',
};

export function behaviorLabel(behavior) {
  return LABELS[behavior] || 'Listening';
}

const TALK_FPS = 7;

export default function Avatar({ behavior = 'listening', speaking = false, thinking = false }) {
  const [frames, setFrames] = useState(null);
  const [talkFrame, setTalkFrame] = useState(0);
  const [blink, setBlink] = useState(false);
  const b = speaking ? 'responding' : behavior;

  useEffect(() => {
    let alive = true;
    loadFrames().then((f) => alive && setFrames(f));
    return () => {
      alive = false;
    };
  }, []);

  // Alternate mouth frames while speaking.
  useEffect(() => {
    if (!speaking) return setTalkFrame(0);
    const id = setInterval(() => setTalkFrame((f) => 1 - f), 1000 / TALK_FPS);
    return () => clearInterval(id);
  }, [speaking]);

  // Blink every few seconds (only if a blink frame exists).
  useEffect(() => {
    if (speaking || !frames?.['listening-blink']) return;
    let t;
    const loop = () => {
      t = setTimeout(() => {
        setBlink(true);
        t = setTimeout(() => {
          setBlink(false);
          loop();
        }, 140);
      }, 2500 + Math.random() * 3000);
    };
    loop();
    return () => clearTimeout(t);
  }, [speaking, frames]);

  const src = frames ? pickFrame(frames, b, talkFrame, blink) : null;

  return (
    <div className={`avatar b-${b}${thinking && !speaking ? ' thinking' : ''}${src ? ' has-art' : ''}`} role="img" aria-label={`Student: ${behaviorLabel(b)}`}>
      {src ? <img className="av-img" src={src} alt="" draggable={false} /> : frames && <Placeholder behavior={b} speaking={speaking} />}
      {thinking && !speaking && (
        <span className="av-dots" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      )}
    </div>
  );
}

// ---- Built-in placeholder face (used until your art is added) ----------------------

function Mouth({ behavior, speaking }) {
  if (speaking) return <ellipse className="av-mouth talking" cx="100" cy="132" rx="11" ry="7" />;
  switch (behavior) {
    case 'confused':
      return <path className="av-mouth" d="M86 134 Q93 129 100 134 T114 134" />;
    case 'understanding':
      return <path className="av-mouth" d="M82 126 Q100 144 118 126" />;
    case 'challenging':
      return <path className="av-mouth" d="M88 133 L112 130" />;
    case 'curious':
      return <ellipse className="av-mouth" cx="100" cy="133" rx="5" ry="6" />;
    default:
      return <path className="av-mouth" d="M88 129 Q100 137 112 129" />;
  }
}

function Placeholder({ behavior, speaking }) {
  return (
    <>
      <svg viewBox="0 0 200 200" className="av-svg">
        <circle className="av-head" cx="100" cy="100" r="76" />
        <path className="av-brow left" d="M62 70 Q73 64 84 68" />
        <path className="av-brow right" d="M116 68 Q127 64 138 70" />
        <g className="av-eyes">
          <circle cx="74" cy="92" r="6" />
          <circle cx="126" cy="92" r="6" />
        </g>
        <Mouth behavior={behavior} speaking={speaking} />
      </svg>
      <span className="av-placeholder">Placeholder avatar</span>
    </>
  );
}

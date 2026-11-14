'use client';

// PLACEHOLDER AVATAR. Your team's hand-drawn character replaces this file (and
// the "Avatar" block in app/globals.css). The rest of the app only uses:
//
//   behavior: 'listening' | 'curious' | 'confused' | 'understanding' | 'challenging' | 'responding'
//             (the student's state from lib/student/behavior.ts)
//   speaking: true while the student's voice is playing
//   thinking: true while the student is forming a reply
//
// Easy swap: one image per behavior (plus a talking loop for `speaking`), a
// Lottie/Rive file with a "behavior" input, or an SVG using these class names.

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

export default function Avatar({ behavior = 'listening', speaking = false, thinking = false }) {
  const b = speaking ? 'responding' : behavior;
  return (
    <div className={`avatar b-${b}${thinking && !speaking ? ' thinking' : ''}`} role="img" aria-label={`Student: ${behaviorLabel(b)}`}>
      <svg viewBox="0 0 200 200" className="av-svg">
        <circle className="av-head" cx="100" cy="100" r="76" />
        <path className="av-brow left" d="M62 70 Q73 64 84 68" />
        <path className="av-brow right" d="M116 68 Q127 64 138 70" />
        <g className="av-eyes">
          <circle cx="74" cy="92" r="6" />
          <circle cx="126" cy="92" r="6" />
        </g>
        <Mouth behavior={b} speaking={speaking} />
      </svg>
      <span className="av-placeholder">Placeholder avatar</span>
    </div>
  );
}

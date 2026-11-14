'use client';

// PLACEHOLDER AVATAR. Replace this file (and the "Avatar" CSS block in
// app/globals.css) with your hand-designed character. The rest of the app only
// relies on these props:
//
//   behavior: 'listening' | 'curious' | 'confused' | 'understanding' | 'challenging' | 'responding'
//             (the student's state from lib/student/behavior.ts)
//   speaking: true while the student's line is being spoken
//   thinking: true while the student is evaluating / choosing what to say
//   level:    the learner level ({ emoji, label })
//
// Easy swap options: one image/GIF per behavior, a Lottie/Rive animation with a
// "behavior" input, or your own SVG using the same class names.

const LABELS = {
  listening: 'Listening',
  curious: 'Curious',
  confused: 'Confused',
  understanding: 'Getting it!',
  challenging: 'Thinking critically',
  responding: 'Talking',
};

export function behaviorLabel(behavior) {
  return LABELS[behavior] || 'Listening';
}

function Mouth({ behavior, speaking }) {
  if (speaking) return <ellipse className="avatar-mouth talking" cx="100" cy="134" rx="14" ry="10" />;
  switch (behavior) {
    case 'confused':
      return <path className="avatar-mouth" d="M82 136 Q91 128 100 136 T118 136" />;
    case 'understanding':
      return <path className="avatar-mouth" d="M78 124 Q100 150 122 124" />;
    case 'challenging':
      return <path className="avatar-mouth" d="M86 134 L114 130" />;
    case 'curious':
      return <ellipse className="avatar-mouth" cx="100" cy="134" rx="6" ry="7" />;
    default:
      return <path className="avatar-mouth" d="M84 128 Q100 140 116 128" />;
  }
}

export default function Avatar({ behavior = 'listening', speaking = false, thinking = false, level }) {
  const b = speaking ? 'responding' : behavior;
  return (
    <div className={`avatar behavior-${b}${thinking && !speaking ? ' is-thinking' : ''}`} aria-label={`Student avatar: ${behaviorLabel(b)}`}>
      <svg viewBox="0 0 200 200" className="avatar-svg">
        <circle className="avatar-head" cx="100" cy="100" r="78" />
        <g className="avatar-brows">
          <path className="brow left" d="M58 66 Q72 58 86 64" />
          <path className="brow right" d="M114 64 Q128 58 142 66" />
        </g>
        <g className="avatar-eyes">
          <ellipse className="eye left" cx="72" cy="88" rx="8" ry="10" />
          <ellipse className="eye right" cx="128" cy="88" rx="8" ry="10" />
        </g>
        <circle className="avatar-cheek" cx="56" cy="114" r="9" />
        <circle className="avatar-cheek" cx="144" cy="114" r="9" />
        <Mouth behavior={b} speaking={speaking} />
      </svg>
      {b === 'confused' && <span className="avatar-mark">?</span>}
      {b === 'understanding' && <span className="avatar-mark spark">!</span>}
      {thinking && !speaking && (
        <div className="avatar-thinking">
          <span />
          <span />
          <span />
        </div>
      )}
      {level && <span className="avatar-badge" title={level.label}>{level.emoji}</span>}
    </div>
  );
}

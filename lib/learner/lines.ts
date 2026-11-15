// Plain but specific student lines for Teach to Learn, used only when the
// reply model fails or produces something generic. Never contain answers.

import { fallbackLine, type LineDetails } from '../student/dialogue.ts';

const stripEnd = (s: string) => s.trim().replace(/[.?!]+$/, '');

export function learnerFallbackLine(intent: string, d: LineDetails & { focusQuote?: string }): string {
  const concept = d.conceptName || 'that';
  switch (intent) {
    case 'reasoning':
      return `Why does ${concept} work that way, though?`;
    case 'assumption':
      return `What has to be true for that to work with ${concept}?`;
    case 'apply_new':
      return `So what would ${concept} mean in a totally different situation?`;
    case 'error_check':
      return d.focusQuote ? `Wait, so if ${stripEnd(d.focusQuote).toLowerCase()}, what would that mean for the rest of it?` : `Hmm, how does that fit with what you said before?`;
    case 'board_clarify':
      return d.focusQuestion ? `${stripEnd(d.focusQuestion)}?` : `What did you write there? I can't quite read it.`;
    case 'board_question':
      return `Can you walk me through what you just drew?`;
    case 'curiosity':
      return `What comes next after ${concept}?`;
    case 'clarify':
      return d.focusQuestion ? `${stripEnd(d.focusQuestion)}?` : `What exactly do you mean by ${concept}?`;
    default:
      return fallbackLine(intent, d);
  }
}

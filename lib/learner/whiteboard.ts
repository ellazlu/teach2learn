// Whiteboard snapshots: when to analyze, and how to clean the vision model's
// reading. The board is never analyzed stroke by stroke: only when the user
// shares it, pauses after drawing, or ends the session, and only if it changed.

import type { BoardAnalysis } from './types.ts';

export const IDLE_MS = 3500; // stop drawing this long = "finished drawing"
export const MIN_AUTO_GAP_MS = 12000; // at most one automatic analysis per 12s

export type BoardTrigger = BoardAnalysis['trigger'];

export interface BoardGate {
  trigger: BoardTrigger;
  version: number; // increments on every stroke/undo/redo/clear
  analyzedVersion: number; // version of the last analyzed snapshot (-1 if none)
  lastAutoAt: number; // ms timestamp of the last automatic analysis
  now: number;
  blank: boolean;
  inFlight: boolean;
}

export function shouldAnalyze(g: BoardGate): boolean {
  if (g.blank || g.inFlight) return false;
  if (g.version === g.analyzedVersion) return false; // nothing new to read
  if (g.trigger === 'pause') return g.now - g.lastAutoAt >= MIN_AUTO_GAP_MS;
  return true; // share, end
}

const clean = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function cleanBoard(raw: any, ctx: { id: string; at: number; trigger: BoardTrigger; conceptIds: string[] }): BoardAnalysis {
  const known = new Set(ctx.conceptIds);
  const unclear = (Array.isArray(raw?.unclear) ? raw.unclear : [])
    .map((u: any) => ({ part: clean(u?.part, 80), question: clean(u?.question, 160) }))
    .filter((u: any) => u.part && u.question)
    .slice(0, 2);
  const transcription = clean(raw?.transcription, 600);
  const description = clean(raw?.description, 600);
  return {
    id: ctx.id,
    at: ctx.at,
    trigger: ctx.trigger,
    transcription,
    description,
    conceptIds: [...new Set((Array.isArray(raw?.concept_ids) ? raw.concept_ids : []).map((x: any) => String(x).toLowerCase()).filter((x: string) => known.has(x)))] as string[],
    unclear,
    blank: !!raw?.blank || (!transcription && !description && !unclear.length),
  };
}

// The text the evaluator judges, as if the user had said it. Unclear parts are
// left out so nothing is judged from a guess.
export function boardSegmentText(a: BoardAnalysis): string {
  const parts = [];
  if (a.transcription) parts.push(`On the whiteboard they wrote: ${a.transcription}`);
  if (a.description) parts.push(`The drawing shows: ${a.description}`);
  return parts.join('. ');
}

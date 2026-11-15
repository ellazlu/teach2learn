// The Teach to Learn concept checklist: 5-10 short concept names, prerequisites
// first, editable by the user before the session. Names only are shown; the
// hidden description (what a correct explanation must say) is what the
// evaluator judges against.

import type { Extraction, ExtractedConcept } from '../student/types.ts';
import { sanitizeExtraction } from '../student/knowledge.ts';

export const MIN_ITEMS = 1;
export const MAX_ITEMS = 12;
export const TARGET = { min: 5, max: 10 };
const NAME_MAX = 60;

export interface ChecklistItem {
  id: string;
  name: string;
  custom: boolean; // added by the user (no hidden description)
}

export function cleanStudyExtraction(raw: Parameters<typeof sanitizeExtraction>[0], fromMaterial: boolean): Extraction {
  const ext = sanitizeExtraction(raw, fromMaterial, TARGET.max);
  return { ...ext, concepts: ext.concepts.map((c) => ({ ...c, name: shortName(c.name) })) };
}

export const shortName = (s: string) => String(s || '').replace(/\s+/g, ' ').trim().replace(/[.:;]+$/, '').slice(0, NAME_MAX);

export function toChecklist(ext: Extraction): ChecklistItem[] {
  return ext.concepts.map((c) => ({ id: c.id, name: c.name, custom: !c.description }));
}

// ---- Editing (pure; used by the review screen) -------------------------------------

export function renameItem(items: ChecklistItem[], id: string, name: string): ChecklistItem[] {
  return items.map((i) => (i.id === id ? { ...i, name: name.slice(0, NAME_MAX) } : i));
}

export function removeItem(items: ChecklistItem[], id: string): ChecklistItem[] {
  return items.filter((i) => i.id !== id);
}

export function moveItem(items: ChecklistItem[], id: string, dir: -1 | 1): ChecklistItem[] {
  const i = items.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= items.length) return items;
  const next = [...items];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function addItem(items: ChecklistItem[], name: string): ChecklistItem[] {
  const n = shortName(name);
  if (!n || items.length >= MAX_ITEMS || items.some((i) => i.name.toLowerCase() === n.toLowerCase())) return items;
  let k = 1;
  while (items.some((i) => i.id === `u${k}`)) k++;
  return [...items, { id: `u${k}`, name: n, custom: true }];
}

export function checklistProblems(items: ChecklistItem[]): string[] {
  const out: string[] = [];
  if (items.length < MIN_ITEMS) out.push('Add at least one concept.');
  if (items.length > MAX_ITEMS) out.push(`Keep it to ${MAX_ITEMS} concepts or fewer.`);
  if (items.some((i) => !shortName(i.name))) out.push('Every concept needs a name.');
  const names = items.map((i) => shortName(i.name).toLowerCase());
  if (new Set(names).size !== names.length) out.push('Two concepts have the same name.');
  return out;
}

// Apply the user's edits to the extraction the student works from. Order is
// the user's; prerequisites can only point at earlier items; misconceptions
// about removed concepts are dropped; added concepts are judged against the
// topic in general (no hidden description).
export function applyChecklist(ext: Extraction, items: ChecklistItem[]): Extraction {
  const byId = new Map(ext.concepts.map((c) => [c.id, c]));
  const concepts: ExtractedConcept[] = [];
  for (const item of items.slice(0, MAX_ITEMS)) {
    const name = shortName(item.name);
    if (!name) continue;
    const orig = byId.get(item.id);
    if (orig) {
      const renamed = name.toLowerCase() !== orig.name.toLowerCase();
      concepts.push({ ...orig, name, keyTerms: renamed ? [...new Set([name, ...orig.keyTerms])] : orig.keyTerms });
    } else {
      concepts.push({
        id: item.id,
        name,
        description: `(Added by the learner.) Judge against standard, accurate knowledge of "${name}" within ${ext.topicTitle || 'this topic'}${ext.fromMaterial ? ' and the uploaded material' : ''}.`,
        difficulty: 2,
        prerequisites: [],
        keyTerms: [name],
      });
    }
  }
  concepts.forEach((c, i) => {
    const earlier = new Set(concepts.slice(0, i).map((x) => x.id));
    c.prerequisites = c.prerequisites.filter((p) => earlier.has(p));
  });
  const kept = new Set(concepts.map((c) => c.id));
  return { ...ext, concepts, misconceptions: ext.misconceptions.filter((m) => kept.has(m.conceptId)) };
}

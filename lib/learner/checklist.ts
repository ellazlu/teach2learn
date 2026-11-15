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
      concepts.push({
        ...orig,
        name,
        // Details never arrived (e.g. the request failed): judge against general knowledge.
        description: orig.description || GENERIC_DESC(name, ext.topicTitle, ext.fromMaterial),
        keyTerms: renamed ? [...new Set([name, ...orig.keyTerms])] : orig.keyTerms,
      });
    } else {
      concepts.push({
        id: item.id,
        name,
        description: GENERIC_DESC(name, ext.topicTitle, ext.fromMaterial),
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

// ---- Two-stage building (outline first, details in the background) -------------------

export const GENERIC_DESC = (name: string, topic: string, fromMaterial: boolean) =>
  `(Added by the learner.) Judge against standard, accurate knowledge of "${name}" within ${topic || 'this topic'}${fromMaterial ? ' and the uploaded material' : ''}.`;

// Stage 1: names + order only. Descriptions stay empty until the details arrive.
export function outlineToExtraction(raw: any, fromMaterial: boolean): Extraction {
  return cleanStudyExtraction(
    {
      topicTitle: raw?.topic_title,
      overview: '',
      concepts: (raw?.concepts || []).map((c: any) => ({ id: c.id, name: c.name, description: '', difficulty: 2, prerequisites: c.prerequisites || [], keyTerms: [String(c.name || '')] })),
      misconceptions: [],
    } as any,
    fromMaterial,
  );
}

export interface ConceptDetails {
  overview: string;
  concepts: { id: string; description: string; difficulty: number; keyTerms: string[] }[];
  misconceptions: { id: string; conceptId: string; belief: string; correction: string }[];
}

export function cleanDetails(raw: any, ids: string[]): ConceptDetails {
  const known = new Set(ids);
  const str = (x: unknown, max: number) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const seenM = new Set<string>();
  return {
    overview: str(raw?.overview, 300),
    concepts: (raw?.concepts || [])
      .map((c: any) => ({ id: str(c?.id, 20).toLowerCase(), description: str(c?.description, 400), difficulty: Math.max(1, Math.min(5, Math.round(Number(c?.difficulty) || 2))), keyTerms: (c?.key_terms || c?.keyTerms || []).map((t: any) => str(t, 40)).filter(Boolean).slice(0, 4) }))
      .filter((c: any) => known.has(c.id) && c.description),
    misconceptions: (raw?.misconceptions || [])
      .map((m: any, i: number) => ({ id: str(m?.id, 20).toLowerCase() || `m${i + 1}`, conceptId: str(m?.concept_id ?? m?.conceptId, 20).toLowerCase(), belief: str(m?.belief, 200), correction: str(m?.correction, 300) }))
      .filter((m: any) => known.has(m.conceptId) && m.belief && !seenM.has(m.id) && seenM.add(m.id))
      .slice(0, 2),
  };
}

// Stage 2 merged into the base extraction (by id). Edits are applied later by
// applyChecklist, so details arriving after the user renamed things still fit.
export function mergeDetails(ext: Extraction, d: ConceptDetails): Extraction {
  const by = new Map(d.concepts.map((c) => [c.id, c]));
  return {
    ...ext,
    overview: d.overview || ext.overview,
    concepts: ext.concepts.map((c) => {
      const x = by.get(c.id);
      return x ? { ...c, description: x.description, difficulty: x.difficulty, keyTerms: [...new Set([c.name, ...x.keyTerms])] } : c;
    }),
    misconceptions: d.misconceptions,
  };
}

export const detailsReady = (ext: Extraction | null) => !!ext && ext.concepts.every((c) => !!c.description);

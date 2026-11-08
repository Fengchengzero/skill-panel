import type { SkillCard } from "./api";

/** Strip trailing -2 / -3 numeric copies and normalize separators. */
export function skillBaseId(id: string): string {
  let base = id.trim().toLowerCase().replace(/_/g, "-");
  while (true) {
    const m = base.match(/^(.*)-(\d+)$/);
    if (!m) break;
    base = m[1];
  }
  return base;
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_\-./\\]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

function tokenSet(s: string): Set<string> {
  return new Set(normalizeText(s).split(/\s+/).filter((t) => t.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** True when two skills look like near-duplicates. */
export function areSkillsSimilar(a: SkillCard, b: SkillCard): boolean {
  if (a.id === b.id) return false;
  if (skillBaseId(a.id) === skillBaseId(b.id)) return true;

  const nameA = normalizeText(a.name);
  const nameB = normalizeText(b.name);
  if (nameA && nameA === nameB) return true;

  const descA = normalizeText(a.description_zh || a.description);
  const descB = normalizeText(b.description_zh || b.description);
  if (descA.length >= 24 && descB.length >= 24) {
    if (descA === descB) return true;
    if (jaccard(tokenSet(descA), tokenSet(descB)) >= 0.82) return true;
  }

  return false;
}

export interface SkillGroup {
  key: string;
  primary: SkillCard;
  duplicates: SkillCard[];
}

/**
 * Collapse similar skills into groups. Prefer: pinned > no numeric suffix > shorter id.
 */
export function groupSimilarSkills(skills: SkillCard[]): SkillGroup[] {
  const remaining = [...skills];
  const groups: SkillGroup[] = [];

  const score = (s: SkillCard) => {
    const base = skillBaseId(s.id);
    const isCopy = s.id.toLowerCase() !== base && /-\d+$/.test(s.id);
    return (s.pinned ? 1000 : 0) + (isCopy ? 0 : 100) + Math.max(0, 40 - s.id.length);
  };

  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    const cluster = [seed];
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (cluster.some((c) => areSkillsSimilar(c, remaining[i]))) {
        cluster.push(remaining.splice(i, 1)[0]);
      }
    }
    cluster.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
    const [primary, ...duplicates] = cluster;
    groups.push({
      key: skillBaseId(primary.id),
      primary,
      duplicates,
    });
  }

  groups.sort((a, b) => {
    if (a.primary.pinned !== b.primary.pinned) return a.primary.pinned ? -1 : 1;
    return a.primary.name.localeCompare(b.primary.name);
  });

  return groups;
}

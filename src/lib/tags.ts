import type { SkillCard } from "./api";

const STOP = new Set([
  "skill",
  "skills",
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "a",
  "an",
  "to",
  "of",
  "in",
  "on",
  "助手",
  "工具",
]);

function pushUnique(out: string[], tag: string, limit: number) {
  const t = tag.trim();
  if (!t || out.includes(t) || out.length >= limit) return;
  out.push(t);
}

/** Prefer saved tags; otherwise derive a few lightweight auto tags. */
export function deriveSkillTags(skill: SkillCard, limit = 3): string[] {
  const out: string[] = [];

  for (const t of skill.tags || []) {
    pushUnique(out, t, limit);
  }
  if (out.length >= limit) return out;

  if (skill.is_native) pushUnique(out, "原生", limit);
  if (skill.pinned) pushUnique(out, "置顶", limit);

  const zh = `${skill.description_zh || ""} ${skill.description || ""}`;
  if (/[\u4e00-\u9fff]/.test(zh)) pushUnique(out, "中文", limit);
  else if (zh.trim()) pushUnique(out, "EN", limit);

  const parts = skill.name
    .split(/[-_\s]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2 && !STOP.has(p.toLowerCase()) && !/^\d+$/.test(p));

  for (const p of parts) {
    pushUnique(out, p.length > 10 ? p.slice(0, 10) : p, limit);
  }

  if (out.length === 0) pushUnique(out, "Skill", limit);
  return out;
}

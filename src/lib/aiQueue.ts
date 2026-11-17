import { api, type SkillCard } from "./api";

/** `zh` = Chinese description generation; `cover` = cover image. */
export type AiJobKind = "zh" | "cover";

function isCancelError(msg: string): boolean {
  return /已取消|cancelled|canceled/i.test(msg);
}

export interface AiJob {
  id: string;
  skillId: string;
  title: string;
  kind: AiJobKind;
}

export interface AiQueueSnapshot {
  pending: AiJob[];
  active: AiJob[];
  done: number;
  failed: number;
  skipped: number;
  total: number;
  running: boolean;
  lastError: string | null;
}

type Listener = (snap: AiQueueSnapshot) => void;

const MAX_CONCURRENCY = 4;

let pending: AiJob[] = [];
let active: AiJob[] = [];
let done = 0;
let failed = 0;
let skipped = 0;
let total = 0;
let lastError: string | null = null;
let clearing = false;
const listeners = new Set<Listener>();
let jobSeq = 0;

function snap(): AiQueueSnapshot {
  return {
    pending: [...pending],
    active: [...active],
    done,
    failed,
    skipped,
    total,
    running: active.length > 0 || pending.length > 0,
    lastError,
  };
}

function emit() {
  const s = snap();
  listeners.forEach((fn) => fn(s));
}

export function subscribeAiQueue(fn: Listener): () => void {
  listeners.add(fn);
  fn(snap());
  return () => listeners.delete(fn);
}

export function getAiQueueSnapshot(): AiQueueSnapshot {
  return snap();
}

function formatErr(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

async function runOne(job: AiJob, onSkills: (skills: SkillCard[]) => void): Promise<void> {
  active = [...active, job];
  emit();
  try {
    if (job.kind === "zh") {
      const result = await api.generateSkillDescription(job.skillId);
      onSkills(result.skills);
    } else {
      const list = await api.generateSkillCover(job.skillId);
      onSkills(list);
    }
    done += 1;
  } catch (e) {
    const msg = formatErr(e);
    if (isCancelError(msg) || clearing) {
      skipped += 1;
    } else {
      failed += 1;
      lastError = msg;
    }
  } finally {
    active = active.filter((j) => j.id !== job.id);
    emit();
  }
}

async function pump(onSkills: (skills: SkillCard[]) => void) {
  while (!clearing && pending.length > 0 && active.length < MAX_CONCURRENCY) {
    const next = pending.shift();
    if (!next) break;
    void runOne(next, onSkills).then(() => {
      void pump(onSkills);
    });
  }
  emit();
}

export async function enqueueAiJobs(
  jobs: Omit<AiJob, "id">[],
  onSkills: (skills: SkillCard[]) => void
): Promise<{ enqueued: number; skipped: number }> {
  clearing = false;
  try {
    await api.clearAiCancel();
  } catch {
    // ignore
  }
  let added = 0;
  let skip = 0;
  for (const job of jobs) {
    const dup =
      pending.some((j) => j.skillId === job.skillId && j.kind === job.kind) ||
      active.some((j) => j.skillId === job.skillId && j.kind === job.kind);
    if (dup) {
      skip += 1;
      continue;
    }
    pending.push({ ...job, id: `job-${++jobSeq}` });
    added += 1;
  }
  skipped += skip;
  total += added;
  emit();
  void pump(onSkills);
  return { enqueued: added, skipped: skip };
}

/** Batch: only fill empty zh / missing cover (O1). */
export async function enqueueBatchForSkills(
  skills: SkillCard[],
  kinds: AiJobKind[],
  onSkills: (skills: SkillCard[]) => void
): Promise<{ enqueued: number; skipped: number }> {
  const jobs: Omit<AiJob, "id">[] = [];
  let skipEmpty = 0;
  for (const skill of skills) {
    const title = skill.display_name || skill.name;
    for (const kind of kinds) {
      if (kind === "zh") {
        if (skill.description_zh?.trim()) {
          skipEmpty += 1;
          continue;
        }
        jobs.push({ skillId: skill.id, title, kind });
      } else if (kind === "cover") {
        if (skill.cover_path) {
          skipEmpty += 1;
          continue;
        }
        jobs.push({ skillId: skill.id, title, kind });
      }
    }
  }
  skipped += skipEmpty;
  const result = await enqueueAiJobs(jobs, onSkills);
  return { enqueued: result.enqueued, skipped: result.skipped + skipEmpty };
}

export async function cancelCurrentAi(): Promise<void> {
  try {
    await api.cancelAi();
  } catch {
    // ignore
  }
}

export async function clearAiQueue(): Promise<void> {
  clearing = true;
  pending = [];
  emit();
  await cancelCurrentAi();
  // allow in-flight to settle; new enqueues will reset clearing
  window.setTimeout(() => {
    clearing = false;
    emit();
  }, 300);
}

export function resetAiQueueStats() {
  done = 0;
  failed = 0;
  skipped = 0;
  total = 0;
  lastError = null;
  emit();
}

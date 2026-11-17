import { cn } from "../lib/cn";

interface Props {
  cols: number;
  rows?: number;
}

export function SkillGridSkeleton({ cols, rows = 2 }: Props) {
  const n = cols * rows;
  return (
    <div
      className="grid min-h-0 flex-1 gap-3 overflow-hidden"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
      aria-hidden="true"
    >
      {Array.from({ length: n }, (_, i) => (
        <div
          key={i}
          className="flex h-full min-h-0 flex-col overflow-hidden rounded-[22px] border border-white/80 bg-white shadow-soft"
        >
          <div className="relative min-h-0 flex-1 overflow-hidden bg-panel-soft">
            <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/50 to-transparent skeleton-sheen" />
          </div>
          <div className="space-y-2 px-3 py-2.5">
            <div className="h-3 w-3/5 rounded-full bg-panel-soft" />
            <div className="h-3 w-4/5 rounded-full bg-panel-soft/80" />
            <div className="flex justify-end">
              <div className="h-6 w-14 rounded-full bg-panel-soft" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Utility class hook — add CSS in index.css */
export function skeletonClass(extra?: string) {
  return cn("relative overflow-hidden bg-panel-soft", extra);
}

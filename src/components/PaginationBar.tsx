import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";

interface Props {
  page: number; // 0-based
  totalPages: number;
  totalItems: number;
  onChange: (page: number) => void;
}

function buildPageList(current: number, total: number): (number | "…")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages = new Set<number>();
  pages.add(1);
  pages.add(total);
  for (let i = current - 1; i <= current + 1; i++) {
    if (i >= 1 && i <= total) pages.add(i);
  }
  if (current <= 3) {
    pages.add(2);
    pages.add(3);
    pages.add(4);
    pages.add(5);
  }
  if (current >= total - 2) {
    pages.add(total - 1);
    pages.add(total - 2);
    pages.add(total - 3);
    pages.add(total - 4);
  }

  const sorted = [...pages].sort((a, b) => a - b);
  const result: (number | "…")[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
      result.push("…");
    }
    result.push(sorted[i]);
  }
  return result;
}

export function PaginationBar({ page, totalPages, totalItems, onChange }: Props) {
  const current = page + 1;
  const [jump, setJump] = useState("");
  const items = useMemo(
    () => buildPageList(current, Math.max(1, totalPages)),
    [current, totalPages]
  );

  const go = (next: number) => {
    const clamped = Math.min(Math.max(1, next), Math.max(1, totalPages));
    onChange(clamped - 1);
  };

  const submitJump = () => {
    const n = Number.parseInt(jump, 10);
    if (!Number.isFinite(n)) return;
    go(n);
    setJump("");
  };

  return (
    <div className="mt-4 flex shrink-0 flex-wrap items-center justify-end gap-3 rounded-[18px] bg-[#eef0f4]/90 px-3 py-2.5">
      <div className="mr-auto text-[12px] text-panel-muted">共 {totalItems} 条</div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={current <= 1}
          onClick={() => go(current - 1)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] bg-white text-panel-ink shadow-inset disabled:opacity-35"
          aria-label="上一页"
        >
          <ChevronLeft size={15} aria-hidden="true" />
        </button>

        {items.map((item, idx) =>
          item === "…" ? (
            <span
              key={`e-${idx}`}
              className="inline-flex h-8 min-w-8 items-center justify-center px-1 text-[13px] text-panel-muted"
            >
              …
            </span>
          ) : (
            <button
              key={item}
              type="button"
              onClick={() => go(item)}
              aria-current={item === current ? "page" : undefined}
              className={cn(
                "inline-flex h-8 min-w-8 items-center justify-center rounded-[10px] px-2 text-[13px] font-semibold transition",
                item === current
                  ? "bg-[#1f2a44] text-white shadow-soft"
                  : "bg-white text-panel-ink shadow-inset hover:bg-white/90"
              )}
            >
              {item}
            </button>
          )
        )}

        <button
          type="button"
          disabled={current >= totalPages}
          onClick={() => go(current + 1)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] bg-white text-panel-ink shadow-inset disabled:opacity-35"
          aria-label="下一页"
        >
          <ChevronRight size={15} aria-hidden="true" />
        </button>

        <div className="ml-1 flex items-center gap-1.5">
          <input
            value={jump}
            onChange={(e) => setJump(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitJump();
            }}
            aria-label="跳转页码"
            className="h-8 w-12 rounded-[10px] border-0 bg-white px-2 text-center text-[13px] outline-none shadow-inset"
          />
          <button
            type="button"
            onClick={submitJump}
            className="h-8 rounded-[10px] bg-white px-2.5 text-[12px] font-semibold text-panel-ink shadow-inset"
          >
            页
          </button>
        </div>
      </div>
    </div>
  );
}

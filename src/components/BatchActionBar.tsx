import { Tags, Wand2, Image, Trash2, X, CheckSquare } from "lucide-react";
import { cn } from "../lib/cn";

interface Props {
  count: number;
  folders: { id: string; name: string }[];
  busy?: boolean;
  pageIds?: string[];
  onSelectPage?: () => void;
  onClear: () => void;
  onMoveFolder: (folderId: string | null) => void;
  onAddTag: (tag: string) => void;
  onGenZh: () => void;
  onGenCover: () => void;
  onDelete: () => void;
  /** Inline header toolbar (default). */
  className?: string;
}

/** Selection actions rendered in the library header (no floating bottom bar). */
export function SelectionToolbar({
  count,
  folders,
  busy = false,
  pageIds = [],
  onSelectPage,
  onClear,
  onMoveFolder,
  onAddTag,
  onGenZh,
  onGenCover,
  onDelete,
  className,
}: Props) {
  if (count <= 0) return null;

  return (
    <div
      className={cn(
        "ui-fade-in-strong flex w-full flex-wrap items-center gap-2 rounded-2xl border border-white/80 bg-white/95 px-3 py-2.5 shadow-soft backdrop-blur",
        className
      )}
    >
      <span className="rounded-full bg-panel-accent px-2.5 py-1 text-[12px] font-semibold text-white">
        已选 {count}
      </span>

      {onSelectPage && pageIds.length > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={onSelectPage}
          className="inline-flex items-center gap-1 rounded-full bg-panel-soft px-2.5 py-1.5 text-[12px] font-semibold text-panel-ink disabled:opacity-50"
          title="全选本页"
        >
          <CheckSquare size={12} aria-hidden="true" />
          本页
        </button>
      )}

      <select
        disabled={busy}
        defaultValue=""
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          onMoveFolder(v === "__none__" ? null : v);
          e.target.value = "";
        }}
        className="rounded-full bg-panel-soft px-3 py-1.5 text-[12px] outline-none disabled:opacity-50"
        aria-label="批量移到文件夹"
      >
        <option value="" disabled>
          移到文件夹…
        </option>
        <option value="__none__">取消分组</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>

      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const tag = String(fd.get("tag") || "").trim();
          if (tag) onAddTag(tag);
          e.currentTarget.reset();
        }}
      >
        <input
          name="tag"
          disabled={busy}
          placeholder="加标签"
          className="w-24 rounded-full bg-panel-soft px-3 py-1.5 text-[12px] outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-full bg-panel-soft px-2.5 py-1.5 text-[12px] font-semibold text-panel-ink disabled:opacity-50"
          title="批量添加标签"
        >
          <Tags size={12} aria-hidden="true" />
          标签
        </button>
      </form>

      <button
        type="button"
        disabled={busy}
        onClick={onGenZh}
        className="inline-flex items-center gap-1 rounded-full bg-panel-soft px-2.5 py-1.5 text-[12px] font-semibold disabled:opacity-50"
        title="批量生成简介（只补空）"
      >
        <Wand2 size={12} aria-hidden="true" />
        简介
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onGenCover}
        className="inline-flex items-center gap-1 rounded-full bg-panel-soft px-2.5 py-1.5 text-[12px] font-semibold disabled:opacity-50"
        title="批量生成封面（只补空）"
      >
        <Image size={12} aria-hidden="true" />
        封面
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onDelete}
        className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-1.5 text-[12px] font-semibold text-rose-700 disabled:opacity-50"
        title="批量删除"
      >
        <Trash2 size={12} aria-hidden="true" />
        删除
      </button>

      <button
        type="button"
        onClick={onClear}
        className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-1.5 text-[12px] text-panel-muted hover:bg-panel-soft"
        title="清除选择"
      >
        <X size={12} aria-hidden="true" />
        清除
      </button>
    </div>
  );
}

/** @deprecated Use SelectionToolbar */
export const BatchActionBar = SelectionToolbar;

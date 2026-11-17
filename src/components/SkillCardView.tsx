import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Pin,
  Copy,
  Sparkles,
  ImagePlus,
  Check,
  Layers,
  X,
  Trash2,
  Wand2,
  Image,
  Loader2,
  GripVertical,
  MoreHorizontal,
} from "lucide-react";
import type { SkillCard } from "../lib/api";
import { deriveSkillTags } from "../lib/tags";
import { cn } from "../lib/cn";
import { StatusBadge } from "./StatusBadge";

interface Props {
  skill: SkillCard;
  onApply: () => Promise<void> | void;
  onCopyOnly: () => Promise<void> | void;
  onTogglePin: () => void;
  onSaveZh: (text: string) => Promise<void> | void;
  onSaveDisplayName: (name: string) => Promise<void> | void;
  onSaveTags: (tags: string[]) => Promise<void> | void;
  onSetCover: () => void;
  onClearCover: () => void;
  onDelete: () => void;
  onOpenDetail: () => void;
  onGenerateZh?: () => Promise<void> | void;
  onGenerateCover?: () => Promise<void> | void;
  onPointerDragStart?: (skillId: string, clientX: number, clientY: number) => void;
  isPointerDragging?: boolean;
  selected?: boolean;
  selectMode?: boolean;
  onToggleSelect?: (skillId: string, additive: boolean) => void;
  generatingZh?: boolean;
  generatingCover?: boolean;
  tone?: number;
  duplicateCount?: number;
  onShowDuplicates?: () => void;
  hasUpdate?: boolean;
}

const TONES = [
  "from-[#f4ebe3] via-[#ebe6f4] to-[#e4f0ea]",
  "from-[#e8e6f4] via-[#eef2f7] to-[#f3ebe4]",
  "from-[#e5f0ea] via-[#eef1f6] to-[#f0e8ef]",
  "from-[#f1e8e2] via-[#e8eef6] to-[#e9e7f3]",
];

export function SkillCardView({
  skill,
  onApply,
  onCopyOnly,
  onTogglePin,
  onSaveZh,
  onSaveDisplayName,
  onSaveTags,
  onSetCover,
  onClearCover,
  onDelete,
  onOpenDetail,
  onGenerateZh,
  onGenerateCover,
  onPointerDragStart,
  isPointerDragging = false,
  selected = false,
  selectMode = false,
  onToggleSelect,
  generatingZh = false,
  generatingCover = false,
  tone = 0,
  duplicateCount = 0,
  onShowDuplicates,
  hasUpdate = false,
}: Props) {
  const aiBusy = generatingZh || generatingCover;
  const [coverMenuOpen, setCoverMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const coverMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  const startPointerDrag = (e: ReactPointerEvent) => {
    if (selectMode) return;
    if (!onPointerDragStart) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, textarea, a, select, label")) return;
    onPointerDragStart(skill.id, e.clientX, e.clientY);
  };

  const coverUrl = useMemo(() => {
    if (!skill.cover_path) return null;
    try {
      return convertFileSrc(skill.cover_path);
    } catch {
      return null;
    }
  }, [skill.cover_path]);

  const title = skill.display_name || skill.name;
  const previewTags = useMemo(() => deriveSkillTags(skill, 3), [skill]);
  const savedTags = skill.tags || [];

  const displayZh =
    skill.description_zh?.trim() ||
    (/[\u4e00-\u9fff]/.test(skill.description || "") ? skill.description : "");
  const [editingZh, setEditingZh] = useState(false);
  const [draftZh, setDraftZh] = useState(displayZh);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(title);
  const [editingTags, setEditingTags] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [applyState, setApplyState] = useState<"idle" | "busy" | "done">("idle");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const tagRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editingZh) setDraftZh(displayZh);
  }, [displayZh, editingZh]);

  useEffect(() => {
    if (!editingName) setDraftName(title);
  }, [title, editingName]);

  useEffect(() => {
    if (editingZh) {
      areaRef.current?.focus();
      areaRef.current?.select();
    }
  }, [editingZh]);

  useEffect(() => {
    if (editingName) {
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [editingName]);

  useEffect(() => {
    if (editingTags) tagRef.current?.focus();
  }, [editingTags]);

  useEffect(() => {
    if (!coverMenuOpen && !moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (coverMenuOpen && coverMenuRef.current && !coverMenuRef.current.contains(t)) {
        setCoverMenuOpen(false);
      }
      if (moreOpen && moreMenuRef.current && !moreMenuRef.current.contains(t)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [coverMenuOpen, moreOpen]);

  const commitZh = async () => {
    setEditingZh(false);
    const next = draftZh.trim();
    if (next === displayZh.trim()) return;
    await onSaveZh(next);
  };

  const commitName = async () => {
    setEditingName(false);
    const next = draftName.trim();
    if (!next || next === title) {
      setDraftName(title);
      return;
    }
    await onSaveDisplayName(next);
  };

  const addTag = async () => {
    const t = tagDraft.trim();
    if (!t) return;
    if (savedTags.includes(t)) {
      setTagDraft("");
      return;
    }
    setTagDraft("");
    await onSaveTags([...savedTags, t]);
  };

  const removeTag = async (tag: string) => {
    await onSaveTags(savedTags.filter((t) => t !== tag));
  };

  const handleApply = async () => {
    if (applyState === "busy") return;
    setApplyState("busy");
    try {
      await onApply();
      setApplyState("done");
      window.setTimeout(() => setApplyState("idle"), 1600);
    } catch {
      setApplyState("idle");
    }
  };

  return (
    <article
      className={cn(
        "group relative flex h-full min-h-0 flex-col overflow-hidden rounded-[22px] border border-white/80 bg-white shadow-soft transition duration-300 ease-out hover:-translate-y-1 hover:scale-[1.01] hover:shadow-float",
        isPointerDragging && "scale-[0.98] opacity-45 ring-2 ring-panel-accent/40",
        selected && "ring-2 ring-panel-accent shadow-float"
      )}
      onClick={(e) => {
        if (!onToggleSelect) return;
        if (selectMode || e.ctrlKey || e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          onToggleSelect(skill.id, true);
        }
      }}
      onDoubleClick={(e) => {
        if (selectMode) return;
        const target = e.target as HTMLElement;
        if (target.closest("button, input, textarea, a, select, label")) return;
        onOpenDetail();
      }}
      title={
        selectMode
          ? "点击选择/取消"
          : "按住封面拖到左侧文件夹 · Ctrl 多选 · 双击打开详情"
      }
    >
      {(selectMode || selected) && (
        <div
          className={cn(
            "absolute left-2 top-2 z-20 flex h-5 w-5 items-center justify-center rounded-md text-[11px] font-bold",
            selected
              ? "bg-panel-accent text-white"
              : "bg-white/90 text-panel-muted ring-1 ring-panel-line"
          )}
          aria-hidden="true"
        >
          {selected ? "✓" : ""}
        </div>
      )}

      <div
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        onPointerDown={startPointerDrag}
      >
        {coverUrl ? (
          <img
            src={coverUrl}
            alt=""
            draggable={false}
            className="pointer-events-none h-full w-full select-none object-cover"
          />
        ) : (
          <div className={cn("h-full w-full select-none bg-gradient-to-br", TONES[tone % TONES.length])} />
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-black/10 to-transparent" />

        <div
          className="pointer-events-none absolute left-2 top-2 z-10 rounded-full bg-black/35 p-1.5 text-white opacity-55 shadow-soft backdrop-blur-sm transition duration-200 group-hover:opacity-100"
          title="按住封面拖到左侧文件夹"
          aria-hidden="true"
        >
          <GripVertical size={12} />
        </div>

        <div
          ref={coverMenuRef}
          className="absolute right-2 top-2 z-10 opacity-0 transition duration-200 focus-within:opacity-100 group-hover:opacity-100"
        >
          <button
            type="button"
            draggable={false}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setCoverMenuOpen((v) => !v);
              setMoreOpen(false);
            }}
            className="rounded-full bg-white/95 p-1.5 text-panel-ink shadow-soft"
            title="封面操作"
            aria-label="封面操作"
            aria-expanded={coverMenuOpen}
          >
            <MoreHorizontal size={12} aria-hidden="true" />
          </button>
          {coverMenuOpen && (
            <div className="absolute right-0 mt-1.5 min-w-[132px] overflow-hidden rounded-xl border border-white/80 bg-white py-1 shadow-float ui-fade-in">
              {onGenerateCover && (
                <button
                  type="button"
                  disabled={aiBusy}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-medium text-panel-ink hover:bg-panel-soft disabled:opacity-50"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCoverMenuOpen(false);
                    if (!aiBusy) void onGenerateCover();
                  }}
                >
                  {generatingCover ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Image size={12} />
                  )}
                  AI 生成封面
                </button>
              )}
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-medium text-panel-ink hover:bg-panel-soft"
                onClick={(e) => {
                  e.stopPropagation();
                  setCoverMenuOpen(false);
                  onSetCover();
                }}
              >
                <ImagePlus size={12} />
                设置封面
              </button>
              {coverUrl && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-medium text-panel-ink hover:bg-panel-soft"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCoverMenuOpen(false);
                    onClearCover();
                  }}
                >
                  <X size={12} />
                  清除封面
                </button>
              )}
            </div>
          )}
        </div>

        <div className="absolute bottom-2.5 left-3 right-3 flex items-end justify-between gap-2">
          <div className="min-w-0 flex-1">
            {editingName ? (
              <input
                ref={nameRef}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={() => void commitName()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setDraftName(title);
                    setEditingName(false);
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitName();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-full rounded-lg bg-white/95 px-2 py-1 text-[15px] font-semibold text-panel-ink outline-none"
                aria-label="编辑显示名称"
              />
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingName(true);
                }}
                className="block max-w-full truncate text-left text-[16px] font-semibold leading-tight tracking-[-0.02em] text-white drop-shadow"
                title="点击编辑显示名称"
              >
                {title}
              </button>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            {skill.pinned && <StatusBadge kind="pinned">置顶</StatusBadge>}
            {skill.local_modified && <StatusBadge kind="modified">已改</StatusBadge>}
            {hasUpdate && <StatusBadge kind="update">更新</StatusBadge>}
            {(generatingZh || generatingCover) && (
              <StatusBadge kind="generating" spinning>
                生成中
              </StatusBadge>
            )}
            {duplicateCount > 0 && (
              <StatusBadge
                kind="dupes"
                icon={Layers}
                onClick={onShowDuplicates}
                title="查看相似技能"
              >
                {duplicateCount}
              </StatusBadge>
            )}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 px-3 pb-2 pt-2">
        <div className="relative h-[40px] overflow-hidden">
          {editingZh ? (
            <textarea
              ref={areaRef}
              value={draftZh}
              onChange={(e) => setDraftZh(e.target.value)}
              onBlur={() => void commitZh()}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setDraftZh(displayZh);
                  setEditingZh(false);
                }
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void commitZh();
                }
              }}
              rows={2}
              placeholder="写一句中文简介…"
              className="h-full w-full resize-none rounded-xl bg-panel-soft/90 px-2.5 py-1.5 text-[12px] leading-5 text-panel-ink outline-none ring-1 ring-panel-accent/20"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingZh(true)}
              className="h-full w-full rounded-xl px-0.5 pr-7 text-left text-[12px] leading-5 text-panel-muted/85 transition hover:bg-panel-soft/60"
              title="点击编辑中文简介"
            >
              <span className={cn("line-clamp-2", !displayZh && "italic opacity-70")}>
                {displayZh || "点击添加中文简介"}
              </span>
            </button>
          )}
          {onGenerateZh && !editingZh && (
            <button
              type="button"
              disabled={aiBusy}
              onClick={(e) => {
                e.stopPropagation();
                if (!aiBusy) void onGenerateZh();
              }}
              className="absolute right-0.5 top-0.5 rounded-full p-1 text-panel-muted opacity-0 transition duration-200 hover:bg-panel-soft hover:text-panel-ink group-hover:opacity-100 disabled:opacity-60"
              title={generatingZh ? "生成简介中…" : "AI 生成中文简介"}
              aria-label="AI 生成中文简介"
            >
              {generatingZh ? (
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              ) : (
                <Wand2 size={12} aria-hidden="true" />
              )}
            </button>
          )}
        </div>

        <div className="min-h-5">
          {editingTags ? (
            <div className="space-y-1" onClick={(e) => e.stopPropagation()}>
              <div className="flex flex-wrap gap-1">
                {savedTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => void removeTag(tag)}
                    className="inline-flex max-w-[45%] items-center gap-0.5 truncate rounded-full bg-panel-soft px-2 py-0.5 text-[10px] font-medium text-panel-ink"
                    title="移除标签"
                  >
                    <span className="truncate">{tag}</span>
                    <X size={9} aria-hidden="true" />
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <input
                  ref={tagRef}
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addTag();
                    }
                    if (e.key === "Escape") {
                      setTagDraft("");
                      setEditingTags(false);
                    }
                  }}
                  onBlur={() => {
                    if (!tagDraft.trim()) setEditingTags(false);
                  }}
                  placeholder="标签，回车"
                  className="min-w-0 flex-1 rounded-lg bg-panel-soft/90 px-2 py-0.5 text-[10px] outline-none ring-1 ring-panel-accent/20"
                />
                <button
                  type="button"
                  onClick={() => setEditingTags(false)}
                  className="rounded-lg px-1.5 py-0.5 text-[10px] font-semibold text-panel-muted"
                >
                  完成
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditingTags(true)}
              className="flex h-5 w-full items-center gap-1 overflow-hidden rounded-lg text-left transition hover:bg-panel-soft/60"
              title="点击编辑标签"
            >
              {(savedTags.length > 0 ? savedTags.slice(0, 3) : previewTags).map((tag) => (
                <span
                  key={tag}
                  className="max-w-[38%] truncate rounded-full bg-panel-soft px-2 py-0.5 text-[10px] font-medium text-panel-muted"
                  title={tag}
                >
                  {tag}
                </span>
              ))}
              {savedTags.length === 0 && (
                <span className="text-[10px] italic text-panel-muted/70">点击添加标签</span>
              )}
            </button>
          )}
        </div>

        <div className="flex h-7 items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => void handleApply()}
            disabled={applyState === "busy"}
            className={cn(
              "inline-flex h-7 items-center justify-center gap-1 rounded-full px-3 text-[11px] font-semibold text-white shadow-soft transition duration-200",
              applyState === "done"
                ? "bg-emerald-600"
                : applyState === "busy"
                  ? "bg-panel-accent/70"
                  : "bg-panel-accent hover:brightness-110 active:scale-[0.98]"
            )}
          >
            {applyState === "done" ? (
              <>
                <Check size={11} aria-hidden="true" />
                已应用
              </>
            ) : (
              <>
                <Sparkles
                  size={11}
                  aria-hidden="true"
                  className={applyState === "busy" ? "animate-pulse" : ""}
                />
                {applyState === "busy" ? "应用中…" : "应用"}
              </>
            )}
          </button>

          <div ref={moreMenuRef} className="relative">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMoreOpen((v) => !v);
                setCoverMenuOpen(false);
              }}
              className="glass-pill inline-flex h-7 w-7 shrink-0 items-center justify-center text-panel-muted opacity-70 transition duration-200 hover:text-panel-ink group-hover:opacity-100"
              title="更多操作"
              aria-label="更多操作"
              aria-expanded={moreOpen}
            >
              <MoreHorizontal size={12} aria-hidden="true" />
            </button>
            {moreOpen && (
              <div className="absolute bottom-8 right-0 z-20 min-w-[128px] overflow-hidden rounded-xl border border-white/80 bg-white py-1 shadow-float ui-fade-in">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-medium text-panel-ink hover:bg-panel-soft"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMoreOpen(false);
                    void onCopyOnly();
                  }}
                >
                  <Copy size={12} />
                  仅复制
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-medium text-panel-ink hover:bg-panel-soft"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMoreOpen(false);
                    onTogglePin();
                  }}
                >
                  <Pin size={12} />
                  {skill.pinned ? "取消置顶" : "置顶"}
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-medium text-rose-600 hover:bg-rose-50"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMoreOpen(false);
                    onDelete();
                  }}
                >
                  <Trash2 size={12} />
                  删除
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

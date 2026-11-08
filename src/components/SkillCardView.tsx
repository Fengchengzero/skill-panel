import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Pin, Copy, Sparkles, ImagePlus, Check, Layers, X } from "lucide-react";
import type { SkillCard } from "../lib/api";
import { deriveSkillTags } from "../lib/tags";
import { cn } from "../lib/cn";

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
  onOpenDetail: () => void;
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
  onOpenDetail,
  tone = 0,
  duplicateCount = 0,
  onShowDuplicates,
  hasUpdate = false,
}: Props) {
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
      draggable
      onDragStart={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("button, input, textarea, a, select, label")) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData("application/x-skill-id", skill.id);
        e.dataTransfer.setData("text/plain", skill.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className="group flex h-full min-h-0 flex-col overflow-hidden rounded-[22px] border border-white/80 bg-white shadow-soft transition duration-300 hover:-translate-y-0.5 hover:shadow-float"
      onDoubleClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("button, input, textarea, a, select, label")) return;
        onOpenDetail();
      }}
      title="双击打开详情 · 拖到左侧分组"
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt=""
            draggable={false}
            className="pointer-events-none h-full w-full object-cover"
          />
        ) : (
          <div className={cn("h-full w-full bg-gradient-to-br", TONES[tone % TONES.length])} />
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-black/10 to-transparent" />
        <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition group-hover:opacity-100">
          <button
            type="button"
            draggable={false}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onSetCover();
            }}
            className="rounded-full bg-white/90 p-1.5 text-panel-ink shadow-soft"
            title="设置封面"
            aria-label="设置封面"
          >
            <ImagePlus size={12} aria-hidden="true" />
          </button>
          {coverUrl && (
            <button
              type="button"
              draggable={false}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onClearCover();
              }}
              className="rounded-full bg-white/90 px-2 py-1.5 text-[10px] font-semibold text-panel-ink shadow-soft"
              title="清除封面"
            >
              无图
            </button>
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
                className="w-full rounded-lg bg-white/95 px-2 py-1 text-[14px] font-semibold text-panel-ink outline-none"
                aria-label="编辑显示名称"
              />
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingName(true);
                }}
                className="block max-w-full truncate text-left text-[15px] font-semibold leading-tight text-white drop-shadow"
                title="点击编辑显示名称"
              >
                {title}
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {skill.local_modified && (
              <span className="rounded-full bg-amber-500 px-2 py-1 text-[10px] font-semibold text-white shadow-soft">
                本地已改
              </span>
            )}
            {hasUpdate && (
              <span className="rounded-full bg-sky-500 px-2 py-1 text-[10px] font-semibold text-white shadow-soft">
                有更新
              </span>
            )}
            {duplicateCount > 0 && (
              <button
                type="button"
                onClick={onShowDuplicates}
                className="inline-flex items-center gap-1 rounded-full bg-amber-50/95 px-2 py-1 text-[10px] font-semibold text-amber-800"
                title="查看相似技能"
              >
                <Layers size={10} aria-hidden="true" />
                {duplicateCount}
              </button>
            )}
            <button
              type="button"
              onClick={onTogglePin}
              className={cn(
                "rounded-full p-1.5 transition",
                skill.pinned ? "bg-panel-accent text-white" : "bg-white/85 text-panel-muted"
              )}
              title="置顶"
              aria-label="置顶"
              aria-pressed={skill.pinned}
            >
              <Pin size={12} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 px-3 pb-2 pt-2">
        <div className="h-[52px] overflow-hidden">
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
              rows={3}
              placeholder="写一句中文简介…"
              className="h-full w-full resize-none rounded-xl bg-panel-soft/90 px-2.5 py-1.5 text-[12px] leading-5 text-panel-ink outline-none ring-1 ring-panel-accent/20"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingZh(true)}
              className="h-full w-full rounded-xl px-0.5 text-left text-[12px] leading-5 text-panel-muted transition hover:bg-panel-soft/60"
              title="点击编辑中文简介"
            >
              <span className={cn("line-clamp-2", !displayZh && "italic opacity-70")}>
                {displayZh || "点击添加中文简介"}
              </span>
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

        <div className="flex h-6 items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => void handleApply()}
            disabled={applyState === "busy"}
            className={cn(
              "inline-flex h-6 items-center justify-center gap-1 rounded-full px-2.5 text-[11px] font-semibold text-white shadow-soft transition",
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
                <Sparkles size={11} aria-hidden="true" className={applyState === "busy" ? "animate-pulse" : ""} />
                {applyState === "busy" ? "应用中…" : "应用"}
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => void onCopyOnly()}
            className="glass-pill inline-flex h-6 w-6 shrink-0 items-center justify-center text-panel-muted"
            title="仅复制 $name"
            aria-label="仅复制调用名"
          >
            <Copy size={11} aria-hidden="true" />
          </button>
        </div>
      </div>
    </article>
  );
}

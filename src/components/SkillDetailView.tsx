import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  CheckSquare,
  Copy,
  ImagePlus,
  Pencil,
  Pin,
  Save,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  type AgentId,
  type Folder,
  type NestedSkillInfo,
  type SkillCard,
} from "../lib/api";
import { cn } from "../lib/cn";

interface Props {
  skill: SkillCard;
  folders: Folder[];
  agent: AgentId;
  onBack: () => void;
  onSkillsChange: (skills: SkillCard[]) => void;
  onApply: () => Promise<void> | void;
  onCopyOnly: () => Promise<void> | void;
  onTogglePin: () => Promise<void> | void;
  onSetCover: () => Promise<void> | void;
  onClearCover: () => Promise<void> | void;
  onDelete: () => Promise<void> | void;
  onToast?: (msg: string) => void;
}

export function SkillDetailView({
  skill,
  folders,
  agent,
  onBack,
  onSkillsChange,
  onApply,
  onCopyOnly,
  onTogglePin,
  onSetCover,
  onClearCover,
  onDelete,
  onToast,
}: Props) {
  const [markdown, setMarkdown] = useState<string>("");
  const [mdDraft, setMdDraft] = useState<string>("");
  const [mdEditing, setMdEditing] = useState(false);
  const [mdSaving, setMdSaving] = useState(false);
  const [mdError, setMdError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(skill.display_name || skill.name);
  const [zhDraft, setZhDraft] = useState(skill.description_zh || "");
  const [tagDraft, setTagDraft] = useState("");
  const [tags, setTags] = useState<string[]>(skill.tags || []);
  const [folderId, setFolderId] = useState(skill.folder_id || "");
  const [busy, setBusy] = useState(false);
  const [nested, setNested] = useState<NestedSkillInfo[]>([]);
  const [nestedLoading, setNestedLoading] = useState(false);
  const [selectedNested, setSelectedNested] = useState<Set<string>>(new Set());
  const [nestedBusy, setNestedBusy] = useState(false);

  useEffect(() => {
    setNameDraft(skill.display_name || skill.name);
    setZhDraft(skill.description_zh || "");
    setTags(skill.tags || []);
    setFolderId(skill.folder_id || "");
  }, [skill]);

  useEffect(() => {
    let cancelled = false;
    setMdError(null);
    setMdEditing(false);
    api
      .readSkillMarkdown(skill.id)
      .then((text) => {
        if (!cancelled) {
          setMarkdown(text);
          setMdDraft(text);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setMarkdown("");
          setMdDraft("");
          setMdError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [skill.id]);

  useEffect(() => {
    let cancelled = false;
    setNestedLoading(true);
    setNested([]);
    setSelectedNested(new Set());
    api
      .listNestedSkills(skill.id)
      .then((list) => {
        if (cancelled) return;
        setNested(list);
        setSelectedNested(new Set(list.filter((n) => !n.already_installed).map((n) => n.rel_path)));
      })
      .catch(() => {
        if (!cancelled) setNested([]);
      })
      .finally(() => {
        if (!cancelled) setNestedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skill.id]);

  const mdDirty = mdEditing && mdDraft !== markdown;
  const selectedCount = selectedNested.size;
  const allNestedSelected = nested.length > 0 && selectedCount === nested.length;

  const handleBack = () => {
    if (mdDirty && !window.confirm("正文有未保存修改，确定离开？")) return;
    onBack();
  };

  const startEditMd = () => {
    setMdDraft(markdown);
    setMdEditing(true);
    setMdError(null);
  };

  const cancelEditMd = () => {
    if (mdDirty && !window.confirm("放弃未保存的修改？")) return;
    setMdDraft(markdown);
    setMdEditing(false);
  };

  const saveMarkdown = async () => {
    if (mdSaving) return;
    setMdSaving(true);
    try {
      const list = await api.writeSkillMarkdown(skill.id, mdDraft);
      onSkillsChange(list);
      setMarkdown(mdDraft);
      setMdEditing(false);
      onToast?.("SKILL.md 已保存");
    } catch (e) {
      setMdError(String(e));
      onToast?.(String(e));
    } finally {
      setMdSaving(false);
    }
  };

  const coverUrl = useMemo(() => {
    if (!skill.cover_path) return null;
    try {
      return convertFileSrc(skill.cover_path);
    } catch {
      return null;
    }
  }, [skill.cover_path]);

  const folderName = folders.find((f) => f.id === skill.folder_id)?.name;

  const saveName = async () => {
    const next = nameDraft.trim();
    if (next === (skill.display_name || skill.name)) return;
    try {
      onSkillsChange(await api.setSkillDisplayName(skill.id, next));
    } catch (e) {
      onToast?.(String(e));
    }
  };

  const saveZh = async () => {
    if (zhDraft.trim() === (skill.description_zh || "").trim()) return;
    try {
      onSkillsChange(await api.setSkillDescriptionZh(skill.id, zhDraft));
    } catch (e) {
      onToast?.(String(e));
    }
  };

  const saveTags = async (next: string[]) => {
    setTags(next);
    try {
      onSkillsChange(await api.setSkillTags(skill.id, next));
    } catch (e) {
      onToast?.(String(e));
      setTags(skill.tags || []);
    }
  };

  const addTag = () => {
    const t = tagDraft.trim();
    if (!t) return;
    if (tags.includes(t)) {
      setTagDraft("");
      return;
    }
    setTagDraft("");
    void saveTags([...tags, t]);
  };

  const saveFolder = async (next: string) => {
    setFolderId(next);
    try {
      onSkillsChange(await api.setSkillFolder(skill.id, next || null));
    } catch (e) {
      onToast?.(String(e));
      setFolderId(skill.folder_id || "");
    }
  };

  const handleApply = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onApply();
    } finally {
      setBusy(false);
    }
  };

  const toggleNested = (relPath: string) => {
    setSelectedNested((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  const toggleAllNested = () => {
    if (allNestedSelected) {
      setSelectedNested(new Set());
    } else {
      setSelectedNested(new Set(nested.map((n) => n.rel_path)));
    }
  };

  const refreshNested = async () => {
    const list = await api.listNestedSkills(skill.id);
    setNested(list);
    setSelectedNested(new Set(list.filter((n) => !n.already_installed).map((n) => n.rel_path)));
  };

  const installSelectedNested = async () => {
    if (nestedBusy || selectedCount === 0) return;
    setNestedBusy(true);
    try {
      const result = await api.installNestedSkills(skill.id, [...selectedNested]);
      const list = await api.listSkills();
      onSkillsChange(list);
      await refreshNested();
      const n = result.installed?.length ?? 0;
      const s = result.skipped?.length ?? 0;
      if (n > 0 && s === 0) onToast?.(`已安装 ${n} 个子技能到库`);
      else if (n > 0) onToast?.(`新装 ${n} 个，跳过 ${s} 个已存在`);
      else if (s > 0) onToast?.(`全部已存在，跳过 ${s} 个`);
      else onToast?.("没有可安装的子技能");
    } catch (e) {
      onToast?.(String(e));
    } finally {
      setNestedBusy(false);
    }
  };

  const expandDeploy = async () => {
    if (nestedBusy || agent === "chatgpt") {
      if (agent === "chatgpt") onToast?.("ChatGPT 仅支持复制调用名");
      return;
    }
    setNestedBusy(true);
    try {
      const result = await api.applySkill(skill.id, agent, false, false, true);
      onToast?.(result.message);
    } catch (e) {
      onToast?.(String(e));
    } finally {
      setNestedBusy(false);
    }
  };

  const copyNestedInvoke = async (id: string) => {
    try {
      await navigator.clipboard.writeText(`$${id}`);
      onToast?.(`已复制 $${id}`);
    } catch {
      onToast?.(`请手动复制 $${id}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="mb-4 flex shrink-0 flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleBack}
          className="glass-pill inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-semibold text-panel-ink"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          返回列表
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-sans text-[28px] font-semibold tracking-[-0.03em]">
            {skill.display_name || skill.name}
          </h1>
          <p className="mt-1 truncate font-en text-[12px] text-panel-muted">{skill.invoke}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => void onTogglePin()}
            className={cn(
              "inline-flex h-9 w-9 items-center justify-center rounded-full transition",
              skill.pinned ? "bg-panel-accent text-white" : "glass-pill text-panel-muted"
            )}
            title="置顶"
            aria-label="置顶"
            aria-pressed={skill.pinned}
          >
            <Pin size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleApply()}
            className="inline-flex items-center gap-1.5 rounded-full bg-panel-accent px-4 py-2 text-[12px] font-semibold text-white shadow-soft disabled:opacity-50"
          >
            <Sparkles size={13} aria-hidden="true" />
            应用
          </button>
          <button
            type="button"
            onClick={() => void onCopyOnly()}
            className="glass-pill inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-semibold text-panel-ink"
          >
            <Copy size={13} aria-hidden="true" />
            复制调用名
          </button>
          <button
            type="button"
            onClick={() => void onDelete()}
            className="glass-pill inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-semibold text-rose-600"
            title="删除技能"
          >
            <Trash2 size={13} aria-hidden="true" />
            删除
          </button>
        </div>
      </header>

      {skill.local_modified && (
        <div className="mb-3 rounded-[16px] border border-amber-200/80 bg-amber-50/90 px-3.5 py-2 text-[12px] text-amber-950">
          本地已修改。若执行「从源更新」会覆盖正文；更新前会自动备份到{" "}
          <span className="font-en">~/.skill-panel/backups</span>
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.4fr)]">
        <section className="flex min-h-0 flex-col gap-3 overflow-auto rounded-[22px] border border-white/80 bg-white/85 p-4 shadow-soft">
          <div className="relative overflow-hidden rounded-2xl">
            {coverUrl ? (
              <img
                src={coverUrl}
                alt=""
                className="h-36 w-full object-cover"
              />
            ) : (
              <div className="flex h-28 items-center justify-center bg-gradient-to-br from-[#f4ebe3] via-[#ebe6f4] to-[#e4f0ea] text-[12px] text-panel-muted">
                无封面
              </div>
            )}
            <div className="absolute bottom-2 right-2 flex gap-1.5">
              <button
                type="button"
                onClick={() => void onSetCover()}
                className="inline-flex items-center gap-1 rounded-full bg-white/95 px-2.5 py-1.5 text-[11px] font-semibold text-panel-ink shadow-soft"
              >
                <ImagePlus size={12} aria-hidden="true" />
                {coverUrl ? "更换" : "设置封面"}
              </button>
              {coverUrl ? (
                <button
                  type="button"
                  onClick={() => void onClearCover()}
                  className="rounded-full bg-white/95 px-2.5 py-1.5 text-[11px] font-semibold text-panel-muted shadow-soft"
                >
                  清除
                </button>
              ) : null}
            </div>
          </div>

          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-panel-muted">显示名称</span>
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => void saveName()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className="w-full rounded-xl border border-panel-line bg-panel-soft/80 px-3 py-2 text-[13px] outline-none ring-panel-accent/20 focus:ring-2"
            />
          </label>

          <div className="grid grid-cols-2 gap-2 text-[12px]">
            <div className="rounded-xl bg-panel-soft/70 px-3 py-2">
              <div className="text-[10px] text-panel-muted">文件夹 ID</div>
              <div className="mt-0.5 truncate font-en font-medium">{skill.id}</div>
            </div>
            <div className="rounded-xl bg-panel-soft/70 px-3 py-2">
              <div className="text-[10px] text-panel-muted">调用名</div>
              <div className="mt-0.5 truncate font-en font-medium">{skill.invoke}</div>
            </div>
          </div>

          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-panel-muted">分组</span>
            <select
              value={folderId}
              onChange={(e) => void saveFolder(e.target.value)}
              className="w-full rounded-xl border border-panel-line bg-panel-soft/80 px-3 py-2 text-[13px] outline-none"
            >
              <option value="">全部（未归组）</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            {folderName ? (
              <span className="text-[10px] text-panel-muted">当前：{folderName}</span>
            ) : null}
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-panel-muted">中文简介</span>
            <textarea
              value={zhDraft}
              onChange={(e) => setZhDraft(e.target.value)}
              onBlur={() => void saveZh()}
              rows={4}
              placeholder="写一句中文简介…"
              className="w-full resize-none rounded-xl border border-panel-line bg-panel-soft/80 px-3 py-2 text-[13px] leading-5 outline-none ring-panel-accent/20 focus:ring-2"
            />
          </label>

          <div className="space-y-1.5">
            <span className="text-[11px] font-semibold text-panel-muted">标签</span>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => void saveTags(tags.filter((t) => t !== tag))}
                  className="inline-flex items-center gap-1 rounded-full bg-panel-soft px-2.5 py-1 text-[11px] font-medium text-panel-ink"
                  title="移除标签"
                >
                  {tag}
                  <X size={10} aria-hidden="true" />
                </button>
              ))}
            </div>
            <div className="flex gap-1.5">
              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                placeholder="添加标签，回车确认"
                className="min-w-0 flex-1 rounded-xl border border-panel-line bg-panel-soft/80 px-3 py-2 text-[12px] outline-none"
              />
              <button
                type="button"
                onClick={addTag}
                className="rounded-xl bg-white px-3 py-2 text-[12px] font-semibold shadow-inset"
              >
                添加
              </button>
            </div>
          </div>

          <div className="rounded-xl bg-panel-soft/70 px-3 py-2 text-[11px] text-panel-muted">
            <div className="font-semibold text-panel-ink/80">路径</div>
            <div className="mt-1 break-all font-en">{skill.path}</div>
          </div>

          {(nestedLoading || nested.length > 0) && (
            <div className="space-y-2 rounded-xl border border-panel-line/80 bg-panel-soft/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[12px] font-semibold text-panel-ink">
                    子技能 {nestedLoading ? "…" : nested.length}
                  </div>
                  <p className="text-[10px] text-panel-muted">
                    整包装入库后可勾选拆成独立技能，或展开部署到 Agent
                  </p>
                </div>
                {nested.length > 0 && (
                  <button
                    type="button"
                    onClick={toggleAllNested}
                    className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[10px] font-semibold text-panel-ink shadow-inset"
                  >
                    {allNestedSelected ? (
                      <CheckSquare size={11} aria-hidden="true" />
                    ) : (
                      <Square size={11} aria-hidden="true" />
                    )}
                    {allNestedSelected ? "取消全选" : "全选"}
                  </button>
                )}
              </div>

              {nested.length > 0 && (
                <>
                  <div className="max-h-48 space-y-1 overflow-auto pr-0.5">
                    {nested.map((n) => {
                      const checked = selectedNested.has(n.rel_path);
                      return (
                        <div
                          key={n.rel_path}
                          className="flex items-start gap-2 rounded-lg bg-white/80 px-2 py-1.5"
                        >
                          <button
                            type="button"
                            onClick={() => toggleNested(n.rel_path)}
                            className="mt-0.5 shrink-0 text-panel-ink"
                            aria-pressed={checked}
                            aria-label={`选择 ${n.id}`}
                          >
                            {checked ? (
                              <CheckSquare size={14} aria-hidden="true" />
                            ) : (
                              <Square size={14} aria-hidden="true" />
                            )}
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-[12px] font-semibold">{n.name}</span>
                              <span className="font-en text-[10px] text-panel-muted">${n.id}</span>
                              {n.already_installed && (
                                <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700">
                                  库中已有
                                </span>
                              )}
                            </div>
                            {n.description ? (
                              <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-panel-muted">
                                {n.description}
                              </p>
                            ) : (
                              <p className="mt-0.5 truncate font-en text-[10px] text-panel-muted">
                                {n.rel_path}
                              </p>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => void copyNestedInvoke(n.id)}
                            className="shrink-0 rounded-full bg-panel-soft px-2 py-1 text-[10px] font-semibold text-panel-muted"
                            title={`复制 $${n.id}`}
                          >
                            复制
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <button
                      type="button"
                      disabled={nestedBusy || selectedCount === 0}
                      onClick={() => void installSelectedNested()}
                      className="rounded-full bg-panel-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
                    >
                      {nestedBusy ? "处理中…" : `安装到库 (${selectedCount})`}
                    </button>
                    <button
                      type="button"
                      disabled={nestedBusy || agent === "chatgpt"}
                      onClick={() => void expandDeploy()}
                      className="rounded-full bg-white px-3 py-1.5 text-[11px] font-semibold text-panel-ink shadow-inset disabled:opacity-50"
                      title="把全部子技能平铺到 Cursor/Codex skills 目录"
                    >
                      展开部署到 Agent
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        <section className="flex min-h-0 flex-col overflow-hidden rounded-[22px] border border-white/80 bg-white/85 shadow-soft">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-panel-line/70 px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-[13px] font-semibold">SKILL.md</h2>
              <p className="text-[10px] text-panel-muted">
                {mdEditing ? (mdDirty ? "编辑中 · 未保存" : "编辑中") : "预览 · 可编辑"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {mdEditing ? (
                <>
                  <button
                    type="button"
                    onClick={cancelEditMd}
                    disabled={mdSaving}
                    className="rounded-full bg-panel-soft px-3 py-1.5 text-[11px] font-semibold text-panel-muted disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveMarkdown()}
                    disabled={mdSaving || !mdDirty}
                    className="inline-flex items-center gap-1 rounded-full bg-panel-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
                  >
                    <Save size={12} aria-hidden="true" />
                    {mdSaving ? "保存中…" : "保存"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={startEditMd}
                  disabled={!!mdError && !markdown}
                  className="inline-flex items-center gap-1 rounded-full bg-panel-soft px-3 py-1.5 text-[11px] font-semibold text-panel-ink disabled:opacity-50"
                >
                  <Pencil size={12} aria-hidden="true" />
                  编辑
                </button>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            {mdError && !mdEditing ? (
              <p className="text-[12px] text-rose-600">{mdError}</p>
            ) : mdEditing ? (
              <textarea
                value={mdDraft}
                onChange={(e) => setMdDraft(e.target.value)}
                spellCheck={false}
                className="h-full min-h-[320px] w-full resize-none rounded-xl border border-panel-line bg-panel-soft/50 px-3 py-2 font-en text-[12px] leading-5 text-panel-ink outline-none ring-panel-accent/20 focus:ring-2"
                aria-label="编辑 SKILL.md"
              />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-en text-[12px] leading-5 text-panel-ink/90">
                {markdown || "加载中…"}
              </pre>
            )}
            {mdError && mdEditing ? (
              <p className="mt-2 text-[12px] text-rose-600">{mdError}</p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

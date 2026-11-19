import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  FolderOpen,
  GitBranch,
  Home,
  Download,
  Search,
  Settings,
  Store,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Layers,
  RefreshCcw,
  CheckSquare,
  Archive,
  ArrowUpDown,
  MoreHorizontal,
} from "lucide-react";
import {
  api,
  type AgentId,
  type AiProgress,
  type AiProvider,
  type AiSettingsPublic,
  type Folder as SkillFolder,
  type SkillCard,
  type InstallProgress,
  type SkillUpdateInfo,
} from "./lib/api";
import { cn } from "./lib/cn";
import { groupSimilarSkills } from "./lib/similarity";
import {
  clearAiQueue,
  enqueueAiJobs,
  enqueueBatchForSkills,
  resetAiQueueStats,
  subscribeAiQueue,
  type AiQueueSnapshot,
} from "./lib/aiQueue";
import { SkillCardView } from "./components/SkillCardView";
import { SkillDetailView } from "./components/SkillDetailView";
import { PaginationBar } from "./components/PaginationBar";
import { SelectionToolbar } from "./components/BatchActionBar";
import { StatusChip } from "./components/StatusBadge";
import { SkillGridSkeleton } from "./components/SkillGridSkeleton";

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
const TOGGLE_SHORTCUT = IS_MAC ? "⌘⇧S" : "Ctrl+Shift+S";
const PATH_PLACEHOLDER = IS_MAC
  ? "或粘贴路径，如 /Users/you/skills/my-skill"
  : "或粘贴路径，如 D:\\skills\\my-skill";

type Tab = "library" | "install" | "settings";
type FolderFilter = "all" | string;
type SkillSort =
  | "pinned_name"
  | "name_asc"
  | "name_desc"
  | "imported_desc"
  | "imported_asc";

const SKILL_SORT_KEY = "skill-panel.sort";
const SKILL_SORT_OPTIONS: { id: SkillSort; label: string }[] = [
  { id: "pinned_name", label: "置顶优先 · 名称" },
  { id: "imported_desc", label: "导入时间 · 新→旧" },
  { id: "imported_asc", label: "导入时间 · 旧→新" },
  { id: "name_asc", label: "名称 · A→Z" },
  { id: "name_desc", label: "名称 · Z→A" },
];

function loadSkillSort(): SkillSort {
  try {
    const v = localStorage.getItem(SKILL_SORT_KEY);
    if (SKILL_SORT_OPTIONS.some((o) => o.id === v)) return v as SkillSort;
  } catch {
    // ignore
  }
  return "pinned_name";
}

function skillTitle(s: SkillCard): string {
  return (s.display_name || s.name || s.id).toLowerCase();
}

function compareSkills(a: SkillCard, b: SkillCard, sort: SkillSort): number {
  const byName = () =>
    skillTitle(a).localeCompare(skillTitle(b), "zh-CN", { sensitivity: "base" });
  const byImported = () => (a.imported_at ?? 0) - (b.imported_at ?? 0);

  switch (sort) {
    case "name_asc":
      return byName() || a.id.localeCompare(b.id);
    case "name_desc":
      return byName() * -1 || b.id.localeCompare(a.id);
    case "imported_desc": {
      const d = byImported() * -1;
      return d || byName();
    }
    case "imported_asc": {
      const d = byImported();
      return d || byName();
    }
    case "pinned_name":
    default: {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return byName() || a.id.localeCompare(b.id);
    }
  }
}

const AGENTS: { id: AgentId; label: string; hint: string }[] = [
  { id: "cursor", label: "Cursor", hint: "部署+粘贴" },
  { id: "codex", label: "Codex", hint: "部署+粘贴" },
  { id: "chatgpt", label: "ChatGPT", hint: "仅粘贴" },
];

const NAV: { id: Tab; icon: typeof Home; label: string }[] = [
  { id: "library", icon: Home, label: "技能库" },
  { id: "install", icon: Download, label: "安装" },
  { id: "settings", icon: Settings, label: "设置" },
];

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "上午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

function todayLabel() {
  return new Intl.DateTimeFormat("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

type TextPresetId = "grsai" | "openai" | "deepseek" | "kimi" | "custom";

const TEXT_PRESETS: Record<
  Exclude<TextPresetId, "custom">,
  { base_url: string; model: string; label: string }
> = {
  grsai: {
    label: "GrsAI",
    base_url: "https://grsai.dakka.com.cn/v1",
    model: "gemini-2.5-flash-lite",
  },
  openai: {
    label: "OpenAI",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  deepseek: {
    label: "DeepSeek",
    base_url: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  kimi: {
    label: "Kimi",
    base_url: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
  },
};

const IMAGE_PRESETS: Record<
  AiProvider,
  { base_url: string; model: string; hint: string }
> = {
  grsai: {
    base_url: "https://grsai.dakka.com.cn/v1",
    model: "gpt-image-2.6",
    hint: "异步 /api/generate（gpt-image / nano-banana）",
  },
  openai: {
    base_url: "https://api.openai.com/v1",
    model: "dall-e-3",
    hint: "同步 /images/generations（OpenAI 或带 Images 的中转）",
  },
};

function guessTextPreset(base: string, _model: string): TextPresetId {
  const b = base.trim().toLowerCase();
  if (b.includes("deepseek")) return "deepseek";
  if (b.includes("moonshot") || b.includes("kimi")) return "kimi";
  if (b.includes("openai.com")) return "openai";
  if (b.includes("grsai") || b.includes("dakka")) return "grsai";
  return "custom";
}

export default function App() {
  const [tab, setTab] = useState<Tab>("library");
  const [skills, setSkills] = useState<SkillCard[]>([]);
  const [folders, setFolders] = useState<SkillFolder[]>([]);
  const [query, setQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all");
  const [hideNative, setHideNative] = useState(true);
  const [collapseDupes, setCollapseDupes] = useState(true);
  const [onlyLocalModified, setOnlyLocalModified] = useState(false);
  const [agent, setAgent] = useState<AgentId>("cursor");
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [gitSubpath, setGitSubpath] = useState("");
  const [sshSource, setSshSource] = useState("");
  const [sshSkill, setSshSkill] = useState("");
  const [cursorDir, setCursorDir] = useState("");
  const [codexDir, setCodexDir] = useState("");
  const [libraryPath, setLibraryPath] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [page, setPage] = useState(0);
  const [cols, setCols] = useState(3);
  const rows = 2; // 固定两行，保证一页至少 6 张
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [outdatedUpdates, setOutdatedUpdates] = useState<SkillUpdateInfo[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [detailSkillId, setDetailSkillId] = useState<string | null>(null);
  const [deleteConfirmSkill, setDeleteConfirmSkill] = useState<SkillCard | null>(null);
  const [deletingSkill, setDeletingSkill] = useState(false);
  const [aiConfirm, setAiConfirm] = useState<{
    skill: SkillCard;
    kind: "zh" | "cover";
  } | null>(null);
  const [aiBusy, setAiBusy] = useState<{ skillId: string; kind: "zh" | "cover" } | null>(
    null
  );
  const [aiProgress, setAiProgress] = useState<AiProgress | null>(null);
  const [aiQueue, setAiQueue] = useState<AiQueueSnapshot | null>(null);
  const [testingAi, setTestingAi] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [skillSort, setSkillSort] = useState<SkillSort>(() => loadSkillSort());
  const [textPreset, setTextPreset] = useState<TextPresetId>("grsai");
  const [textKeyDraft, setTextKeyDraft] = useState("");
  const [textBaseUrl, setTextBaseUrl] = useState(TEXT_PRESETS.grsai.base_url);
  const [textModel, setTextModel] = useState(TEXT_PRESETS.grsai.model);
  const [textKeySet, setTextKeySet] = useState(false);
  const [textKeyHint, setTextKeyHint] = useState("");
  const [imageProvider, setImageProvider] = useState<AiProvider>("grsai");
  const [imageKeyDraft, setImageKeyDraft] = useState("");
  const [imageBaseUrl, setImageBaseUrl] = useState(IMAGE_PRESETS.grsai.base_url);
  const [imageModel, setImageModel] = useState(IMAGE_PRESETS.grsai.model);
  const [imageKeySet, setImageKeySet] = useState(false);
  const [imageKeyHint, setImageKeyHint] = useState("");
  const [aiImageAspect, setAiImageAspect] = useState("16:9");
  const [aiImageResolution, setAiImageResolution] = useState("4K");
  const [aiPromptText, setAiPromptText] = useState("");
  const [aiPromptImage, setAiPromptImage] = useState("");
  const [savingAi, setSavingAi] = useState(false);
  const [headerMoreOpen, setHeaderMoreOpen] = useState(false);
  const [aiTextOpen, setAiTextOpen] = useState(true);
  const [aiImageOpen, setAiImageOpen] = useState(true);
  const [aiPromptsOpen, setAiPromptsOpen] = useState(false);
  const headerMoreRef = useRef<HTMLDivElement>(null);
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null);
  /** Git / market install only — does not block library or other actions */
  const [gitInstallKind, setGitInstallKind] = useState<"git" | "market" | null>(null);
  const gitInstallKindRef = useRef<"git" | "market" | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  gitInstallKindRef.current = gitInstallKind;
  const newFolderRef = useRef<HTMLInputElement>(null);
  const dialogOpenRef = useRef(false);

  const showToast = (msg: string, ms = 2800) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), ms);
  };

  const formatErr = (e: unknown) => {
    if (typeof e === "string") return e;
    if (e && typeof e === "object") {
      const anyErr = e as { message?: unknown; error?: unknown };
      if (typeof anyErr.message === "string" && anyErr.message.trim()) return anyErr.message;
      try {
        return JSON.stringify(e);
      } catch {
        /* ignore */
      }
    }
    return String(e);
  };

  const refresh = useCallback(async () => {
    const [list, folderList, paths, meta, tags] = await Promise.all([
      api.listSkills(),
      api.listFolders(),
      api.getPaths(),
      api.getMeta(),
      api.listTags(),
    ]);
    setSkills(list);
    setFolders(folderList);
    setLibraryPath(paths.skills);
    setCursorDir(meta.cursor_skills_dir || "");
    setCodexDir(meta.codex_skills_dir || "");
    setAllTags(tags);
    setExpandedFolders((prev) => {
      const next = { ...prev };
      for (const f of folderList) {
        if (next[f.id] === undefined) next[f.id] = true;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    refresh().catch((e) => showToast(String(e)));
  }, [refresh]);

  const applyAiSettings = (s: AiSettingsPublic) => {
    setTextBaseUrl(s.text_base_url);
    setTextModel(s.text_model);
    setTextKeySet(s.text_api_key_set);
    setTextKeyHint(s.text_api_key_hint);
    setTextKeyDraft("");
    setTextPreset(guessTextPreset(s.text_base_url, s.text_model));
    setImageProvider(s.image_provider === "openai" ? "openai" : "grsai");
    setImageBaseUrl(s.image_base_url);
    setImageModel(s.image_model);
    setImageKeySet(s.image_api_key_set);
    setImageKeyHint(s.image_api_key_hint);
    setImageKeyDraft("");
    setAiImageAspect(s.image_aspect);
    setAiImageResolution(s.image_resolution || "4K");
    setAiPromptText(s.prompt_text);
    setAiPromptImage(s.prompt_image);
  };

  const applyTextPreset = (id: TextPresetId) => {
    setTextPreset(id);
    if (id === "custom") return;
    const p = TEXT_PRESETS[id];
    setTextBaseUrl(p.base_url);
    setTextModel(p.model);
  };

  const switchImageProvider = (next: AiProvider) => {
    if (next === imageProvider) return;
    const preset = IMAGE_PRESETS[next];
    setImageProvider(next);
    setImageBaseUrl(preset.base_url);
    setImageModel(preset.model);
    setAiImageResolution(next === "openai" ? "1K" : "4K");
  };

  const loadAiSettings = useCallback(async () => {
    const s = await api.getAiSettings();
    applyAiSettings(s);
  }, []);

  useEffect(() => {
    if (tab !== "settings") return;
    loadAiSettings().catch((e) => showToast(String(e)));
  }, [tab, loadAiSettings]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 文件对话框打开时不要把主窗口藏掉，否则用户会以为导入没反应
      if (dialogOpenRef.current) return;
      if (aiConfirm && !aiBusy) {
        setAiConfirm(null);
        return;
      }
      if (deleteConfirmSkill) {
        if (!deletingSkill) setDeleteConfirmSkill(null);
        return;
      }
      if (selectedIds.length > 0 || selectMode) {
        setSelectedIds([]);
        setSelectMode(false);
        return;
      }
      if (detailSkillId) {
        setDetailSkillId(null);
        return;
      }
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        void getCurrentWindow().hide();
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    detailSkillId,
    deleteConfirmSkill,
    deletingSkill,
    aiConfirm,
    aiBusy,
    selectedIds.length,
    selectMode,
  ]);

  useEffect(() => {
    if (creatingFolder) newFolderRef.current?.focus();
  }, [creatingFolder]);

  const baseSkills = useMemo(() => {
    let list = hideNative ? skills.filter((s) => !s.is_native) : skills;
    if (onlyLocalModified) list = list.filter((s) => s.local_modified);
    return list;
  }, [skills, hideNative, onlyLocalModified]);

  const filtered = useMemo(() => {
    return baseSkills.filter((s) => {
      const q = query.trim().toLowerCase();
      const text =
        `${s.display_name || s.name} ${s.name} ${s.description} ${s.description_zh} ${s.invoke}`.toLowerCase();
      const hitQuery = !q || text.includes(q) || s.tags.some((t) => t.toLowerCase().includes(q));
      const hitFolder = folderFilter === "all" ? true : s.folder_id === folderFilter;
      const hitTags =
        selectedTags.length === 0 ||
        selectedTags.some((tag) => s.tags.some((t) => t.toLowerCase() === tag.toLowerCase()));
      return hitQuery && hitFolder && hitTags;
    });
  }, [baseSkills, query, folderFilter, selectedTags]);

  const skillGroups = useMemo(() => groupSimilarSkills(filtered), [filtered]);
  const duplicateGroupCount = useMemo(
    () => skillGroups.filter((g) => g.duplicates.length > 0).length,
    [skillGroups]
  );
  const duplicateSkillCount = useMemo(
    () => skillGroups.reduce((n, g) => n + g.duplicates.length, 0),
    [skillGroups]
  );
  const visibleSkills = useMemo(() => {
    const list = collapseDupes ? skillGroups.map((g) => g.primary) : [...filtered];
    list.sort((a, b) => compareSkills(a, b, skillSort));
    return list;
  }, [collapseDupes, filtered, skillGroups, skillSort]);
  const dupCountById = useMemo(() => {
    const map: Record<string, number> = {};
    for (const g of skillGroups) {
      if (g.duplicates.length > 0) map[g.primary.id] = g.duplicates.length;
    }
    return map;
  }, [skillGroups]);

  // Only reset paging when filters/search change — not when items are deleted
  // (safePage already clamps if the last page becomes empty).
  useEffect(() => {
    setPage(0);
  }, [query, folderFilter, selectedTags, hideNative, onlyLocalModified, collapseDupes, skillSort]);

  useEffect(() => {
    try {
      localStorage.setItem(SKILL_SORT_KEY, skillSort);
    } catch {
      // ignore
    }
  }, [skillSort]);

  useEffect(() => {
    if (!headerMoreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (headerMoreRef.current && !headerMoreRef.current.contains(e.target as Node)) {
        setHeaderMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [headerMoreOpen]);

  useEffect(() => {
    if (tab !== "library") return;
    const el = gridRef.current;
    if (!el) return;

    const measure = () => {
      const w = el.clientWidth;
      const gap = 12;
      // 目标一页 6 张：至少 3 列 × 2 行；更宽时可 4 列
      const nextCols = Math.max(3, Math.min(4, Math.floor((w + gap) / (210 + gap))));
      setCols(nextCols);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab, visibleSkills.length]);

  const pageSize = cols * rows; // 3×2=6 或 4×2=8
  const totalPages = Math.max(1, Math.ceil(visibleSkills.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = visibleSkills.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const pinnedCount = baseSkills.filter((s) => s.pinned).length;
  const nativeCount = skills.filter((s) => s.is_native).length;

  const cleanDuplicates = async () => {
    const toDelete = skillGroups.flatMap((g) => g.duplicates.map((d) => d.id));
    if (toDelete.length === 0) return;
    if (
      !window.confirm(
        `将删除 ${toDelete.length} 个相似副本（保留每组主技能）。此操作不可撤销，继续？`
      )
    ) {
      return;
    }
    try {
      setBusy(true);
      let list = skills;
      for (const id of toDelete) {
        list = await api.deleteSkill(id);
      }
      setSkills(list);
      showToast(`已清理 ${toDelete.length} 个重复技能`);
    } catch (e) {
      showToast(String(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const revealDuplicates = (skillId: string) => {
    const group = skillGroups.find((g) => g.primary.id === skillId);
    if (!group || group.duplicates.length === 0) return;
    setCollapseDupes(false);
    showToast(
      `「${group.primary.name}」还有相似：${group.duplicates.map((d) => d.name).join("、")}`
    );
  };

  const outdatedIdSet = useMemo(
    () => new Set(outdatedUpdates.map((u) => u.skill_id)),
    [outdatedUpdates]
  );

  const checkUpdates = async () => {
    try {
      setBusy(true);
      showToast("正在检查更新…");
      const list = await api.checkSkillUpdates();
      const outdated = list.filter((u) => u.status === "outdated");
      const missing = list.filter((u) => u.status === "missing_source").length;
      const gone = list.filter((u) => u.status === "source_gone").length;
      setOutdatedUpdates(outdated);
      if (outdated.length > 0) {
        showToast(`发现 ${outdated.length} 个可更新`);
      } else if (missing > 0 || gone > 0) {
        showToast(
          `没有可更新项（无来源 ${missing}，来源失效 ${gone}）。重新导入可补全来源`
        );
      } else {
        showToast("全部已是最新");
      }
    } catch (e) {
      showToast(`检查失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const applyOneUpdate = async (skillId: string) => {
    const info = outdatedUpdates.find((u) => u.skill_id === skillId);
    if (info?.local_modified) {
      const ok = window.confirm(
        `「${info.name}」有本地修改。从源更新会覆盖本地文件（已自动备份到 ~/.skill-panel/backups）。继续？`
      );
      if (!ok) return;
    }
    try {
      setBusy(true);
      const list = await api.updateSkill(skillId);
      setSkills(list);
      setOutdatedUpdates((prev) => prev.filter((u) => u.skill_id !== skillId));
      showToast(
        info?.local_modified
          ? `已更新 ${info.name}（原文件已备份）`
          : `已更新 ${skillId}`
      );
    } catch (e) {
      showToast(`更新失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const applyAllUpdates = async () => {
    const ids = outdatedUpdates.map((u) => u.skill_id);
    if (ids.length === 0) return;
    const modifiedCount = outdatedUpdates.filter((u) => u.local_modified).length;
    if (modifiedCount > 0) {
      const ok = window.confirm(
        `其中 ${modifiedCount} 个技能有本地修改，更新会覆盖本地文件（会先备份）。确定全部更新？`
      );
      if (!ok) return;
    }
    try {
      setBusy(true);
      const result = await api.updateSkills(ids);
      await refresh();
      setOutdatedUpdates([]);
      if (result.updated.length > 0 && result.errors.length === 0) {
        showToast(
          modifiedCount > 0
            ? `已更新 ${result.updated.length} 个（含本地修改，已备份）`
            : `已更新 ${result.updated.length} 个技能`
        );
      } else if (result.updated.length > 0) {
        showToast(`更新 ${result.updated.length} 个，失败 ${result.errors.length} 个`);
      } else {
        showToast(result.errors[0] || "更新失败");
      }
    } catch (e) {
      showToast(`更新失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [skillDrag, setSkillDrag] = useState<{
    skillId: string;
    title: string;
    x: number;
    y: number;
  } | null>(null);
  const skillDragRef = useRef<{
    skillId: string;
    title: string;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);

  const assignSkillToFolder = async (skillId: string, folderId: string | null) => {
    try {
      const list = await api.setSkillFolder(skillId, folderId);
      setSkills(list);
      const folderName =
        folderId == null ? "全部（取消分组）" : folders.find((f) => f.id === folderId)?.name || "分组";
      showToast(`已移到「${folderName}」`);
    } catch (e) {
      showToast(String(e));
    } finally {
      skillDragRef.current = null;
      setSkillDrag(null);
      setDragOverFolderId(null);
    }
  };

  const beginSkillPointerDrag = (skillId: string, clientX: number, clientY: number) => {
    const skill = skills.find((s) => s.id === skillId);
    const title = skill?.display_name || skill?.name || skillId;
    skillDragRef.current = {
      skillId,
      title,
      startX: clientX,
      startY: clientY,
      active: false,
    };
  };

  const assignSkillToFolderRef = useRef(assignSkillToFolder);
  assignSkillToFolderRef.current = assignSkillToFolder;
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const pending = skillDragRef.current;
      if (!pending) return;
      const dx = e.clientX - pending.startX;
      const dy = e.clientY - pending.startY;
      if (!pending.active && dx * dx + dy * dy < 36) return;
      if (!pending.active) {
        pending.active = true;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }
      setSkillDrag({
        skillId: pending.skillId,
        title: pending.title,
        x: e.clientX,
        y: e.clientY,
      });
      // temporarily hide ghost so elementFromPoint hits the folder underneath
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const drop = el?.closest("[data-folder-drop]") as HTMLElement | null;
      const folderKey = drop?.dataset.folderDrop ?? null;
      setDragOverFolderId(folderKey);
      if (folderKey && folderKey !== "all") {
        setExpandedFolders((prev) =>
          prev[folderKey] ? prev : { ...prev, [folderKey]: true }
        );
      }
    };

    const onUp = (e: PointerEvent) => {
      const pending = skillDragRef.current;
      if (!pending) return;
      const wasActive = pending.active;
      const skillId = pending.skillId;
      skillDragRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setSkillDrag(null);
      if (!wasActive) {
        setDragOverFolderId(null);
        return;
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const drop = el?.closest("[data-folder-drop]") as HTMLElement | null;
      const folderKey = drop?.dataset.folderDrop;
      setDragOverFolderId(null);
      if (!folderKey) {
        showToastRef.current("未放到文件夹上");
        return;
      }
      void assignSkillToFolderRef.current(skillId, folderKey === "all" ? null : folderKey);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const withDialogFocus = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    // 置顶面板会挡住 Windows 原生文件对话框：只临时取消置顶，不要 hide，
    // 否则对话框经常跑到后台/看不见，看起来像「一键导入没实现」。
    dialogOpenRef.current = true;
    try {
      await win.setAlwaysOnTop(false);
      await win.show();
      await win.unminimize();
      await win.setFocus();
      await new Promise((r) => window.setTimeout(r, 60));
      return await fn();
    } finally {
      dialogOpenRef.current = false;
      try {
        await win.show();
        await win.unminimize();
        await win.setAlwaysOnTop(true);
        await win.setFocus();
      } catch {
        // restore best-effort
      }
    }
  };

  const reportInstallResult = useCallback(
    (result: {
      installed?: string[];
      skipped?: { similar_to?: string; name: string }[];
      errors?: string[];
    }) => {
      const installed = result.installed ?? [];
      const skipped = result.skipped ?? [];
      const errors = result.errors ?? [];

      if (errors.length > 0 && installed.length === 0 && skipped.length === 0) {
        showToast(errors[0].replace(/^.*?:\s*/, "") || errors[0]);
      } else if (installed.length > 0 && skipped.length === 0) {
        showToast(
          installed.length === 1
            ? `已安装 ${installed[0]}`
            : `已安装 ${installed.length} 个技能`
        );
      } else if (installed.length > 0 && skipped.length > 0) {
        showToast(`新装 ${installed.length} 个，跳过 ${skipped.length} 个已存在`);
      } else if (skipped.length > 0) {
        showToast(`这些技能已在库中，已跳过（共 ${skipped.length} 个）`);
      } else if (errors.length > 0) {
        showToast(`部分失败 ${errors.length} 个`);
      } else {
        showToast("没有导入任何技能（可能已取消，或目录里没有 Skill）");
      }
    },
    []
  );

  const finishLocalInstall = useCallback(
    async (paths: string | string[]) => {
      const list = (Array.isArray(paths) ? paths : [paths])
        .map((p) => p.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      if (list.length === 0) {
        showToast("未选择有效路径");
        return;
      }

      const installed: string[] = [];
      const skipped: { similar_to?: string; name: string }[] = [];
      const errors: string[] = [];
      for (const path of list) {
        try {
          const result = await api.installLocal(path);
          installed.push(...(result.installed ?? []));
          skipped.push(...(result.skipped ?? []));
          errors.push(...(result.errors ?? []));
        } catch (e) {
          errors.push(String(e));
        }
      }

      await refresh();
      setTab("library");
      reportInstallResult({ installed, skipped, errors });
    },
    [refresh, reportInstallResult]
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      try {
        const fn = await getCurrentWebview().onDragDropEvent(async (event) => {
          if (event.payload.type !== "drop") return;
          const paths = event.payload.paths;
          if (!paths?.length) return;
          try {
            setBusy(true);
            await finishLocalInstall(paths);
          } catch (e) {
            showToast(String(e));
          } finally {
            setBusy(false);
          }
        });
        if (cancelled) fn();
        else unlisten = fn;
      } catch {
        // browser preview without tauri runtime
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [finishLocalInstall]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      try {
        const fn = await listen<InstallProgress>("install-progress", (event) => {
          if (!gitInstallKindRef.current) return;
          setInstallProgress(event.payload);
        });
        if (cancelled) fn();
        else unlisten = fn;
      } catch {
        // ignore in browser preview
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      try {
        const fn = await listen<AiProgress>("ai-progress", (event) => {
          setAiProgress(event.payload);
        });
        if (cancelled) fn();
        else unlisten = fn;
      } catch {
        // ignore
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => subscribeAiQueue(setAiQueue), []);

  const applySkillsFromAi = useCallback((list: SkillCard[]) => {
    setSkills(list);
  }, []);

  const toggleSelect = useCallback((skillId: string, _additive: boolean) => {
    setSelectedIds((prev) =>
      prev.includes(skillId) ? prev.filter((id) => id !== skillId) : [...prev, skillId]
    );
  }, []);

  const selectedSkills = useMemo(
    () => skills.filter((s) => selectedIds.includes(s.id)),
    [skills, selectedIds]
  );

  const quickImport = async () => {
    try {
      setBusy(true);
      showToast("请选择技能库目录（可选上级文件夹）…");
      // 走 Rust 原生选文件夹，避免置顶窗口把 JS 对话框弄没
      const result = await api.pickAndInstallLocal();
      await refresh();
      setTab("library");
      reportInstallResult(result);
    } catch (e) {
      showToast(`导入失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const installLocalFile = async () => {
    try {
      setBusy(true);
      showToast("请选择 Skill 文件…");
      const selected = await withDialogFocus(() =>
        open({
          multiple: true,
          title: "选择 SKILL.md / .zip / .skill（可多选）",
          filters: [
            { name: "Skill", extensions: ["md", "zip", "skill"] },
            { name: "All", extensions: ["*"] },
          ],
        })
      );
      if (!selected) {
        showToast("已取消导入");
        return;
      }
      await finishLocalInstall(selected);
    } catch (e) {
      showToast(`导入失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const installLocalPath = async () => {
    const path = localPath.trim().replace(/^["']|["']$/g, "");
    if (!path) {
      showToast("请先粘贴本地路径");
      return;
    }
    try {
      setBusy(true);
      await finishLocalInstall(path);
      setLocalPath("");
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const summarizeInstall = (result: Awaited<ReturnType<typeof api.installGit>>) => {
    if (result.installed.length > 0 && result.skipped.length === 0) {
      showToast(
        result.installed.length === 1
          ? `已安装 ${result.installed[0]}`
          : `已安装 ${result.installed.length} 个技能`
      );
      return;
    }
    if (result.installed.length > 0) {
      showToast(`新装 ${result.installed.length} 个，跳过 ${result.skipped.length} 个相似重复`);
      return;
    }
    if (result.skipped.length > 0) {
      const first = result.skipped[0];
      showToast(first.reason || `与「${first.similar_to}」相似，已跳过`);
      return;
    }
    showToast("没有可安装的技能");
  };

  const cancelGitInstall = async () => {
    try {
      await api.cancelInstall();
      setInstallProgress((prev) =>
        prev
          ? { ...prev, message: "正在取消…" }
          : { stage: "cancel", percent: 0, message: "正在取消…" }
      );
    } catch (e) {
      showToast(String(e));
    }
  };

  const installGit = async () => {
    if (!gitUrl.trim() || gitInstallKind) return;
    // Set ref immediately so early install-progress events are not dropped before re-render.
    gitInstallKindRef.current = "git";
    try {
      setGitInstallKind("git");
      setInstallProgress({ stage: "prepare", percent: 1, message: "开始从 Git 安装…" });
      const result = await api.installGit(gitUrl.trim(), gitSubpath.trim() || undefined);
      await refresh();
      summarizeInstall(result);
      setTab("library");
    } catch (e) {
      const msg = String(e);
      showToast(msg.includes("已取消") ? "已取消 Git 安装" : msg);
    } finally {
      gitInstallKindRef.current = null;
      setGitInstallKind(null);
      setInstallProgress(null);
    }
  };

  const installMarket = async () => {
    if (!sshSource.trim() || !sshSkill.trim() || gitInstallKind) return;
    gitInstallKindRef.current = "market";
    try {
      setGitInstallKind("market");
      setInstallProgress({ stage: "prepare", percent: 1, message: "开始从 GitHub 源安装…" });
      const result = await api.installSkillssh(sshSource.trim(), sshSkill.trim());
      await refresh();
      summarizeInstall(result);
      setTab("library");
    } catch (e) {
      const msg = String(e);
      showToast(msg.includes("已取消") ? "已取消安装" : msg);
    } finally {
      gitInstallKindRef.current = null;
      setGitInstallKind(null);
      setInstallProgress(null);
    }
  };

  const saveSettings = async () => {
    const meta = await api.getMeta();
    await api.saveMeta({
      ...meta,
      cursor_skills_dir: cursorDir.trim() || null,
      codex_skills_dir: codexDir.trim() || null,
    });
    showToast("路径设置已保存");
  };

  const saveAiSettings = async () => {
    if (savingAi) return;
    setSavingAi(true);
    try {
      const s = await api.saveAiSettings({
        text_api_key: textKeyDraft.trim() ? textKeyDraft.trim() : null,
        text_base_url: textBaseUrl.trim(),
        text_model: textModel.trim(),
        image_api_key: imageKeyDraft.trim() ? imageKeyDraft.trim() : null,
        image_provider: imageProvider,
        image_base_url: imageBaseUrl.trim(),
        image_model: imageModel.trim(),
        image_aspect: aiImageAspect.trim() || "16:9",
        image_resolution: aiImageResolution.trim() || "4K",
        prompt_text: aiPromptText,
        prompt_image: aiPromptImage,
      });
      applyAiSettings(s);
      showToast("AI 设置已保存");
    } catch (e) {
      showToast(String(e));
    } finally {
      setSavingAi(false);
    }
  };

  const resetAiPrompts = async () => {
    try {
      const s = await api.resetAiPrompts();
      applyAiSettings(s);
      showToast("已恢复默认提示词");
    } catch (e) {
      showToast(String(e));
    }
  };

  const runGenerateZh = async (skill: SkillCard) => {
    setAiConfirm(null);
    setAiBusy({ skillId: skill.id, kind: "zh" });
    setAiProgress({
      kind: "zh",
      skill_id: skill.id,
      stage: "start",
      percent: 5,
      message: "开始生成简介…",
    });
    try {
      await api.clearAiCancel();
      resetAiQueueStats();
      await enqueueAiJobs(
        [{ skillId: skill.id, title: skill.display_name || skill.name, kind: "zh" }],
        applySkillsFromAi
      );
      showToast("简介任务已加入队列");
    } catch (e) {
      showToast(formatErr(e), 12000);
      setAiBusy(null);
      setAiProgress(null);
    }
  };

  const runGenerateCover = async (skill: SkillCard) => {
    setAiConfirm(null);
    setAiBusy({ skillId: skill.id, kind: "cover" });
    setAiProgress({
      kind: "cover",
      skill_id: skill.id,
      stage: "start",
      percent: 5,
      message: "开始生成封面（提示词→出图，可能需要 1–3 分钟）…",
    });
    try {
      await api.clearAiCancel();
      resetAiQueueStats();
      await enqueueAiJobs(
        [{ skillId: skill.id, title: skill.display_name || skill.name, kind: "cover" }],
        applySkillsFromAi
      );
      showToast("封面任务已加入队列");
    } catch (e) {
      showToast(formatErr(e), 12000);
      setAiBusy(null);
      setAiProgress(null);
    }
  };

  useEffect(() => {
    if (!aiQueue) return;
    if (aiQueue.running) {
      const cur = aiQueue.active[0];
      if (cur) {
        setAiBusy({ skillId: cur.skillId, kind: cur.kind });
      }
      return;
    }
    // queue drained
    if (aiBusy) {
      setAiBusy(null);
      setAiProgress(null);
      if (aiQueue.failed > 0 && aiQueue.lastError) {
        showToast(aiQueue.lastError, 12000);
      } else if (aiQueue.done > 0) {
        showToast(
          `生成完成：成功 ${aiQueue.done}${aiQueue.skipped ? `，跳过 ${aiQueue.skipped}` : ""}`
        );
      }
    }
  }, [aiQueue, aiBusy]);

  const testAiConnection = async () => {
    if (testingAi) return;
    setTestingAi(true);
    try {
      const msg = await api.testAiConnection();
      showToast(msg, 6000);
    } catch (e) {
      showToast(formatErr(e), 12000);
    } finally {
      setTestingAi(false);
    }
  };

  const requestGenerateZh = (skill: SkillCard) => {
    const hasZh = Boolean(skill.description_zh?.trim());
    if (hasZh) {
      setAiConfirm({ skill, kind: "zh" });
      return;
    }
    void runGenerateZh(skill);
  };

  const requestGenerateCover = (skill: SkillCard) => {
    if (skill.cover_path) {
      setAiConfirm({ skill, kind: "cover" });
      return;
    }
    void runGenerateCover(skill);
  };

  const confirmAiGenerate = () => {
    if (!aiConfirm) return;
    if (aiConfirm.kind === "zh") void runGenerateZh(aiConfirm.skill);
    else void runGenerateCover(aiConfirm.skill);
  };

  const cancelAiAll = async () => {
    await clearAiQueue();
    setAiBusy(null);
    setAiProgress(null);
    showToast("已取消生成任务");
  };

  const batchGen = async (kinds: Array<"zh" | "cover">) => {
    if (selectedSkills.length === 0) return;
    resetAiQueueStats();
    const { enqueued, skipped } = await enqueueBatchForSkills(
      selectedSkills,
      kinds,
      applySkillsFromAi
    );
    showToast(
      enqueued
        ? `已入队 ${enqueued} 个任务${skipped ? `，跳过 ${skipped} 个已有内容` : ""}`
        : `无可生成项（已跳过 ${skipped}）`
    );
  };

  const batchMoveFolder = async (folderId: string | null) => {
    try {
      let list: SkillCard[] | null = null;
      for (const id of selectedIds) {
        list = await api.setSkillFolder(id, folderId);
      }
      if (list) setSkills(list);
      showToast("已批量移动分组");
      setSelectedIds([]);
    } catch (e) {
      showToast(formatErr(e));
    }
  };

  const batchAddTag = async (tag: string) => {
    try {
      let list: SkillCard[] | null = null;
      for (const skill of selectedSkills) {
        const tags = skill.tags?.includes(tag) ? skill.tags : [...(skill.tags || []), tag];
        list = await api.setSkillTags(skill.id, tags);
      }
      if (list) {
        setSkills(list);
        setAllTags(await api.listTags());
      }
      showToast(`已添加标签「${tag}」`);
    } catch (e) {
      showToast(formatErr(e));
    }
  };

  const batchDelete = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`确认删除选中的 ${selectedIds.length} 个技能？不可撤销。`)) return;
    try {
      let list: SkillCard[] | null = null;
      for (const id of selectedIds) {
        list = await api.deleteSkill(id);
      }
      if (list) setSkills(list);
      setSelectedIds([]);
      showToast("已批量删除");
    } catch (e) {
      showToast(formatErr(e));
    }
  };

  const recompressCovers = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    try {
      const [result, list] = await api.recompressCovers();
      setSkills(list);
      showToast(result.message, 8000);
    } catch (e) {
      showToast(formatErr(e), 12000);
    } finally {
      setBackupBusy(false);
    }
  };

  const exportBackup = async (asFolder: boolean) => {
    if (backupBusy) return;
    setBackupBusy(true);
    try {
      const dest = asFolder
        ? await withDialogFocus(() =>
            open({ directory: true, title: "选择导出目录（将在其下创建备份文件夹）" })
          )
        : await withDialogFocus(() =>
            save({
              title: "导出备份 ZIP",
              defaultPath: "skill-panel-backup.zip",
              filters: [{ name: "ZIP", extensions: ["zip"] }],
            })
          );
      if (!dest) return;
      const path = Array.isArray(dest) ? dest[0] : dest;
      if (!path) return;
      let outPath = path;
      if (!asFolder && !String(path).toLowerCase().endsWith(".zip")) {
        outPath = `${path}.zip`;
      } else if (asFolder) {
        const sep = String(path).includes("\\") && !String(path).includes("/") ? "\\" : "/";
        outPath = `${String(path).replace(/[\\/]+$/, "")}${sep}skill-panel-backup`;
      }
      const result = await api.exportLibrary(outPath, asFolder);
      showToast(result.message, 6000);
    } catch (e) {
      showToast(formatErr(e), 12000);
    } finally {
      setBackupBusy(false);
    }
  };

  const pickRestore = async () => {
    try {
      const picked = await withDialogFocus(() =>
        open({
          multiple: false,
          title: "选择备份 ZIP",
          filters: [{ name: "Backup", extensions: ["zip"] }],
        })
      );
      if (picked && !Array.isArray(picked)) {
        setRestoreConfirm(picked);
        return;
      }
      const dir = await withDialogFocus(() =>
        open({ directory: true, title: "或选择备份文件夹" })
      );
      if (!dir || Array.isArray(dir)) return;
      setRestoreConfirm(dir);
    } catch (e) {
      showToast(formatErr(e));
    }
  };

  const confirmRestore = async (mode: "replace" | "merge_skip") => {
    if (!restoreConfirm) return;
    setBackupBusy(true);
    try {
      const result = await api.importLibrary(restoreConfirm, mode);
      setSkills(result.skills);
      await refresh();
      showToast(result.message, 6000);
      setRestoreConfirm(null);
    } catch (e) {
      showToast(formatErr(e), 12000);
    } finally {
      setBackupBusy(false);
    }
  };

  const onApply = async (skill: SkillCard, copyOnly: boolean) => {
    const result = await api.applySkill(skill.id, agent, copyOnly, !copyOnly);
    showToast(result.message);
  };

  const commitCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      setCreatingFolder(false);
      setNewFolderName("");
      return;
    }
    try {
      const list = await api.createFolder(name);
      setFolders(list);
      setExpandedFolders((prev) => ({ ...prev, [list[list.length - 1]?.id]: true }));
      showToast(`已创建「${name}」`);
    } catch (e) {
      showToast(String(e));
    } finally {
      setCreatingFolder(false);
      setNewFolderName("");
    }
  };

  const commitRenameFolder = async (folder: SkillFolder) => {
    const name = renameDraft.trim();
    setRenamingFolderId(null);
    if (!name || name === folder.name) return;
    try {
      const list = await api.renameFolder(folder.id, name);
      setFolders(list);
    } catch (e) {
      showToast(String(e));
    }
  };

  const onDeleteFolder = async (folder: SkillFolder) => {
    if (!window.confirm(`删除文件夹「${folder.name}」？技能不会被删除，只是回到全部列表。`)) return;
    try {
      const list = await api.deleteFolder(folder.id);
      setFolders(list);
      if (folderFilter === folder.id) setFolderFilter("all");
      await refresh();
    } catch (e) {
      showToast(String(e));
    }
  };

  const onSaveZh = async (skill: SkillCard, text: string) => {
    const list = await api.setSkillDescriptionZh(skill.id, text);
    setSkills(list);
  };

  const onSaveDisplayName = async (skill: SkillCard, name: string) => {
    const list = await api.setSkillDisplayName(skill.id, name);
    setSkills(list);
    setAllTags(await api.listTags());
  };

  const onSaveTags = async (skill: SkillCard, tags: string[]) => {
    const list = await api.setSkillTags(skill.id, tags);
    setSkills(list);
    setAllTags(await api.listTags());
  };

  const toggleTagFilter = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const detailSkill = useMemo(
    () => (detailSkillId ? skills.find((s) => s.id === detailSkillId) || null : null),
    [detailSkillId, skills]
  );

  const onSetCover = async (skill: SkillCard) => {
    try {
      // Native Rust picker — more reliable than JS dialog under always-on-top
      const list = await api.pickAndSetSkillCover(skill.id);
      if (!list) return;
      setSkills(list);
      showToast("封面已更新");
    } catch (e) {
      showToast(String(e));
    }
  };

  const onClearCover = async (skill: SkillCard) => {
    try {
      const list = await api.clearSkillCover(skill.id);
      setSkills(list);
      showToast("封面已清除");
    } catch (e) {
      showToast(String(e));
    }
  };

  const requestDeleteSkill = (skill: SkillCard) => {
    setDeleteConfirmSkill(skill);
  };

  const cancelDeleteSkill = () => {
    if (deletingSkill) return;
    setDeleteConfirmSkill(null);
  };

  const confirmDeleteSkill = async () => {
    if (!deleteConfirmSkill || deletingSkill) return;
    const skill = deleteConfirmSkill;
    const label = skill.display_name || skill.name;
    setDeletingSkill(true);
    try {
      const list = await api.deleteSkill(skill.id);
      setSkills(list);
      setAllTags(await api.listTags());
      if (detailSkillId === skill.id) setDetailSkillId(null);
      setOutdatedUpdates((prev) => prev.filter((u) => u.skill_id !== skill.id));
      setDeleteConfirmSkill(null);
      showToast(`已删除「${label}」`);
    } catch (e) {
      showToast(String(e));
    } finally {
      setDeletingSkill(false);
    }
  };

  const folderCounts = useMemo(() => {
    const map: Record<string, number> = { all: baseSkills.length };
    for (const f of folders) map[f.id] = 0;
    for (const s of baseSkills) {
      if (s.folder_id && map[s.folder_id] !== undefined) map[s.folder_id] += 1;
    }
    return map;
  }, [baseSkills, folders]);

  const skillsByFolder = useMemo(() => {
    const map: Record<string, SkillCard[]> = {};
    for (const f of folders) map[f.id] = [];
    for (const s of baseSkills) {
      if (s.folder_id && map[s.folder_id]) map[s.folder_id].push(s);
    }
    return map;
  }, [baseSkills, folders]);

  const toggleExpand = (id: string) => {
    setExpandedFolders((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const renderFolderChildren = (folderId: string) => {
    const list = skillsByFolder[folderId] || [];
    if (!expandedFolders[folderId]) return null;
    if (list.length === 0) {
      return (
        <div
          className={cn(
            "ml-6 border-l border-panel-line/80 py-1 pl-3 text-[10px]",
            skillDrag ? "font-medium text-panel-accent" : "text-panel-muted/80"
          )}
        >
          {skillDrag ? "松开以放入此文件夹" : "暂无技能"}
        </div>
      );
    }
    return (
      <div className="ml-5 space-y-0.5 border-l border-panel-line py-1 pl-2">
        {list.slice(0, 12).map((skill) => (
          <button
            key={skill.id}
            type="button"
            onClick={() => {
              setTab("library");
              setDetailSkillId(null);
              setFolderFilter(folderId);
              setQuery(skill.display_name || skill.name);
            }}
            className="flex w-full items-center gap-1.5 truncate rounded-lg px-2 py-1 text-left text-[11px] text-panel-muted transition-colors duration-200 hover:bg-panel-mint/70 hover:text-panel-ink"
            title={skill.display_name || skill.name}
          >
            <span className="h-1 w-1 shrink-0 rounded-full bg-panel-accent/50" aria-hidden="true" />
            <span className="truncate">{skill.display_name || skill.name}</span>
          </button>
        ))}
        {list.length > 12 && (
          <div className="px-2 py-0.5 text-[10px] text-panel-muted">还有 {list.length - 12} 个…</div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full p-4 font-sans text-panel-ink md:p-5">
      <div className="glass-shell flex h-full overflow-hidden">
        <aside className="flex w-[280px] shrink-0 flex-col border-r border-panel-line bg-white/35 p-3.5">
          <div className="mb-3 flex items-end justify-between gap-2 px-0.5">
            <div>
              <div className="font-sans text-[22px] font-semibold leading-none tracking-[-0.04em]">
                SKILL
              </div>
              <div className="mt-0.5 text-[10px] tracking-[0.16em] text-panel-muted/70">PANEL</div>
            </div>
            <nav className="flex gap-0.5" aria-label="主导航">
              {NAV.map(({ id, icon: Icon, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setTab(id);
                    if (id !== "library") setDetailSkillId(null);
                  }}
                  aria-current={tab === id ? "page" : undefined}
                  title={label}
                  aria-label={label}
                  className={cn(
                    "inline-flex h-8 w-8 items-center justify-center rounded-xl transition",
                    tab === id
                      ? "bg-white text-panel-ink shadow-inset"
                      : "text-panel-muted/70 hover:bg-white/70 hover:text-panel-ink"
                  )}
                >
                  <Icon size={14} strokeWidth={1.7} aria-hidden="true" />
                </button>
              ))}
            </nav>
          </div>

          <section className="mb-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-white/70 bg-white/70 p-2 shadow-soft">
            <div className="mb-2 flex items-center justify-between px-1.5 pt-0.5">
              <div>
                <div className="text-[13px] font-semibold tracking-[-0.02em] text-panel-ink">
                  技能文件夹
                </div>
                <div className="text-[10px] text-panel-muted">拖拽卡片到此归类</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCreatingFolder(true);
                  setNewFolderName("");
                }}
                className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-panel-soft text-panel-ink transition hover:bg-white"
                title="新建文件夹"
                aria-label="新建文件夹"
              >
                <FolderPlus size={15} aria-hidden="true" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-1 overflow-auto px-0.5 pb-0.5">
              {skillDrag && (
                <div className="mb-1 rounded-xl bg-panel-accent/10 px-2.5 py-1.5 text-[11px] font-medium text-panel-accent">
                  拖到下方文件夹即可归类 · 拖到「全部」取消分组
                </div>
              )}
              <button
                type="button"
                data-folder-drop="all"
                onClick={() => {
                  setTab("library");
                  setDetailSkillId(null);
                  setFolderFilter("all");
                  setQuery("");
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-2xl px-3 py-2.5 text-left transition",
                  dragOverFolderId === "all" && "ring-2 ring-panel-accent/50 bg-panel-mint/90 scale-[1.01]",
                  skillDrag && dragOverFolderId !== "all" && "ring-1 ring-dashed ring-panel-accent/25",
                  folderFilter === "all" && tab === "library"
                    ? "bg-panel-accent text-white shadow-soft"
                    : "bg-panel-soft/80 text-panel-ink hover:bg-white"
                )}
              >
                <span className="text-[13px] font-semibold">
                  {dragOverFolderId === "all" ? "松开以取消分组" : "全部技能"}
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    folderFilter === "all" && tab === "library"
                      ? "bg-white/20 text-white"
                      : "bg-white text-panel-muted"
                  )}
                >
                  {folderCounts.all}
                </span>
              </button>

              {folders.map((folder) => {
                const active = folderFilter === folder.id && tab === "library";
                const count = folderCounts[folder.id] || 0;
                const isDropTarget = dragOverFolderId === folder.id;
                return (
                  <div
                    key={folder.id}
                    data-folder-drop={folder.id}
                    className={cn(
                      "rounded-2xl transition",
                      isDropTarget && "bg-panel-mint/80 ring-2 ring-panel-accent/45 scale-[1.01]",
                      skillDrag && !isDropTarget && "ring-1 ring-dashed ring-panel-accent/20",
                      active ? "bg-white shadow-inset" : "bg-transparent hover:bg-white/70"
                    )}
                  >
                    <div className="group flex items-center gap-0.5 p-1">
                      <button
                        type="button"
                        onClick={() => toggleExpand(folder.id)}
                        className="inline-flex h-9 w-8 items-center justify-center rounded-xl text-panel-muted transition hover:bg-panel-mint/70"
                        title={expandedFolders[folder.id] ? "收起" : "展开"}
                        aria-label={
                          expandedFolders[folder.id] ? `收起${folder.name}` : `展开${folder.name}`
                        }
                        aria-expanded={!!expandedFolders[folder.id]}
                      >
                        {expandedFolders[folder.id] ? (
                          <ChevronDown size={14} aria-hidden="true" />
                        ) : (
                          <ChevronRight size={14} aria-hidden="true" />
                        )}
                      </button>

                      {renamingFolderId === folder.id ? (
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => void commitRenameFolder(folder)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void commitRenameFolder(folder);
                            if (e.key === "Escape") setRenamingFolderId(null);
                          }}
                          aria-label="重命名文件夹"
                          className="min-w-0 flex-1 rounded-xl border border-panel-line bg-white px-2.5 py-2 text-[13px]"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setTab("library");
                            setDetailSkillId(null);
                            setFolderFilter(folder.id);
                            setQuery("");
                          }}
                          className="flex min-w-0 flex-1 items-center justify-between rounded-xl px-2 py-2 text-left transition"
                        >
                          <span className="inline-flex min-w-0 items-center gap-2">
                            <span
                              className={cn(
                                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xl",
                                active ? "bg-panel-accent/10 text-panel-accent" : "bg-panel-soft text-panel-muted"
                              )}
                            >
                              <Folder size={14} aria-hidden="true" />
                            </span>
                            <span
                              className={cn(
                                "truncate text-[13px] font-semibold",
                                active ? "text-panel-ink" : "text-panel-ink/85"
                              )}
                            >
                              {isDropTarget ? `松开归入「${folder.name}」` : folder.name}
                            </span>
                          </span>
                          <span
                            className={cn(
                              "ml-2 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                              active ? "bg-panel-soft text-panel-ink" : "bg-white/80 text-panel-muted"
                            )}
                          >
                            {count}
                          </span>
                        </button>
                      )}

                      <button
                        type="button"
                        className="hidden h-8 w-8 items-center justify-center rounded-xl text-panel-muted transition hover:bg-panel-mint/70 group-hover:inline-flex"
                        onClick={() => {
                          setRenamingFolderId(folder.id);
                          setRenameDraft(folder.name);
                        }}
                        title="重命名"
                        aria-label={`重命名 ${folder.name}`}
                      >
                        <Pencil size={12} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="hidden h-8 w-8 items-center justify-center rounded-xl text-panel-muted transition hover:bg-panel-mint/70 group-hover:inline-flex"
                        onClick={() => void onDeleteFolder(folder)}
                        title="删除"
                        aria-label={`删除 ${folder.name}`}
                      >
                        <Trash2 size={12} aria-hidden="true" />
                      </button>
                    </div>
                    {renderFolderChildren(folder.id)}
                  </div>
                );
              })}

              {creatingFolder && (
                <div className="rounded-2xl border border-panel-line bg-white p-2">
                  <input
                    ref={newFolderRef}
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onBlur={() => void commitCreateFolder()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitCreateFolder();
                      if (e.key === "Escape") {
                        setCreatingFolder(false);
                        setNewFolderName("");
                      }
                    }}
                    placeholder="新文件夹名称"
                    aria-label="新文件夹名称"
                    className="w-full rounded-xl bg-panel-soft px-3 py-2 text-[13px] outline-none"
                  />
                </div>
              )}

              {folders.length === 0 && !creatingFolder && (
                <button
                  type="button"
                  onClick={() => {
                    setCreatingFolder(true);
                    setNewFolderName("");
                  }}
                  className="w-full rounded-2xl border border-dashed border-panel-line px-3 py-4 text-center text-[12px] text-panel-muted transition hover:border-panel-accent/30 hover:bg-white hover:text-panel-ink"
                >
                  {skillDrag
                    ? "还没有文件夹，先点此新建再拖入"
                    : "还没有文件夹，点此新建"}
                </button>
              )}
            </div>
          </section>

          <section className="mb-1.5 space-y-1 opacity-80">
            <div className="px-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-panel-muted/70">
              筛选
            </div>
            <div className="flex flex-wrap gap-1">
              <StatusChip
                kind="native"
                active={hideNative}
                aria-pressed={hideNative}
                title={hideNative ? "已隐藏原生技能" : "显示原生技能"}
                onClick={() => setHideNative((v) => !v)}
              >
                {hideNative ? <EyeOff size={11} aria-hidden="true" /> : <Eye size={11} aria-hidden="true" />}
                原生 {nativeCount}
              </StatusChip>
              <StatusChip
                kind="dupes"
                active={collapseDupes}
                aria-pressed={collapseDupes}
                title={collapseDupes ? "已折叠相似技能" : "展开全部相似"}
                onClick={() => setCollapseDupes((v) => !v)}
              >
                <Layers size={11} aria-hidden="true" />
                相似 {duplicateSkillCount}
              </StatusChip>
              <StatusChip
                kind="select"
                active={selectMode || selectedIds.length > 0}
                aria-pressed={selectMode}
                title={selectMode ? "退出选择模式" : "进入选择模式（也可 Ctrl 点选）"}
                onClick={() => {
                  setSelectMode((v) => !v);
                  if (selectMode) setSelectedIds([]);
                }}
              >
                <CheckSquare size={11} aria-hidden="true" />
                选择{selectedIds.length > 0 ? ` ${selectedIds.length}` : ""}
              </StatusChip>
              <StatusChip
                kind="modified"
                active={onlyLocalModified}
                aria-pressed={onlyLocalModified}
                title={onlyLocalModified ? "仅看本地已改" : "筛选本地已改"}
                onClick={() => setOnlyLocalModified((v) => !v)}
              >
                <Pencil size={11} aria-hidden="true" />
                已改{" "}
                {skills.filter((s) => s.local_modified && (!hideNative || !s.is_native)).length}
              </StatusChip>
            </div>
          </section>

          <section className="mb-1 opacity-85">
            <div className="mb-1 px-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-panel-muted/70">
              Agent
            </div>
            <div className="flex gap-1 rounded-2xl bg-white/45 p-1">
              {AGENTS.map((item) => {
                const on = agent === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setAgent(item.id)}
                    aria-pressed={on}
                    title={`${item.label} · ${item.hint}`}
                    className={cn(
                      "min-w-0 flex-1 rounded-xl px-1.5 py-1.5 text-center text-[11px] font-semibold transition",
                      on
                        ? "bg-panel-accent text-white shadow-soft"
                        : "text-panel-muted hover:bg-white hover:text-panel-ink"
                    )}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </section>

          <div className="flex items-center justify-between px-1 pt-1 text-[9px] text-panel-muted/60">
            <span>{TOGGLE_SHORTCUT}</span>
            <span>Esc</span>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-panel-surface/55 p-6" id="main-content">
          {tab === "library" && detailSkill && (
            <SkillDetailView
              skill={detailSkill}
              folders={folders}
              agent={agent}
              onBack={() => setDetailSkillId(null)}
              onSkillsChange={(list) => {
                setSkills(list);
                void api.listTags().then(setAllTags);
              }}
              onApply={() => onApply(detailSkill, false)}
              onCopyOnly={() => onApply(detailSkill, true)}
              onTogglePin={async () => setSkills(await api.togglePin(detailSkill.id))}
              onSetCover={() => onSetCover(detailSkill)}
              onClearCover={() => onClearCover(detailSkill)}
              onDelete={() => requestDeleteSkill(detailSkill)}
              onToast={showToast}
            />
          )}

          {tab === "library" && !detailSkill && (
            <>
              <header className="mb-4 flex shrink-0 flex-col gap-3">
                <div className="flex flex-wrap items-end gap-4">
                  <div className="min-w-[220px]">
                    <h1 className="font-sans text-[34px] font-semibold leading-none tracking-[-0.03em]">
                      {greeting()}
                    </h1>
                    <p className="mt-2 text-[13px] text-panel-muted">
                      {todayLabel()} · {visibleSkills.length} skills
                      {collapseDupes && duplicateSkillCount > 0
                        ? ` · 已折叠 ${duplicateSkillCount} 相似`
                        : ""}
                      {pinnedCount > 0 ? ` · ${pinnedCount} 置顶` : ""}
                      {hideNative && nativeCount > 0 ? ` · 已藏 ${nativeCount} 原生` : ""}
                      {selectedTags.length > 0 ? ` · 标签 ${selectedTags.length}` : ""}
                    </p>
                  </div>

                  {selectedIds.length === 0 ? (
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      <label className="glass-pill inline-flex items-center gap-1.5 px-3 py-2.5 text-[12px] font-semibold text-panel-ink">
                        <ArrowUpDown size={14} aria-hidden="true" />
                        <span className="sr-only">排序</span>
                        <select
                          value={skillSort}
                          onChange={(e) => setSkillSort(e.target.value as SkillSort)}
                          aria-label="技能排序"
                          className="max-w-[140px] bg-transparent outline-none"
                        >
                          {SKILL_SORT_OPTIONS.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="glass-pill flex min-w-[240px] flex-1 items-center gap-2 px-4 py-2.5 sm:min-w-[280px]">
                        <Search size={15} className="text-panel-muted" aria-hidden="true" />
                        <input
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder="搜索技能"
                          aria-label="搜索技能"
                          className="w-full bg-transparent text-[13px] outline-none placeholder:text-panel-muted"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void quickImport()}
                        className="rounded-full bg-panel-accent px-4 py-2.5 text-[12px] font-semibold text-white shadow-soft disabled:opacity-50"
                      >
                        一键导入
                      </button>
                      <div ref={headerMoreRef} className="relative">
                        <button
                          type="button"
                          onClick={() => setHeaderMoreOpen((v) => !v)}
                          className="glass-pill inline-flex items-center gap-1 px-3 py-2.5 text-[12px] font-semibold text-panel-ink"
                          aria-expanded={headerMoreOpen}
                          aria-label="更多操作"
                        >
                          <MoreHorizontal size={14} aria-hidden="true" />
                          更多
                        </button>
                        {headerMoreOpen && (
                          <div className="absolute right-0 z-30 mt-1.5 min-w-[150px] overflow-hidden rounded-xl border border-white/80 bg-white py-1 shadow-float ui-fade-in">
                            <button
                              type="button"
                              disabled={busy}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-panel-ink hover:bg-panel-soft disabled:opacity-50"
                              onClick={() => {
                                setHeaderMoreOpen(false);
                                void checkUpdates();
                              }}
                            >
                              <RefreshCcw size={13} />
                              检查更新
                            </button>
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-panel-ink hover:bg-panel-soft"
                              onClick={() => {
                                setHeaderMoreOpen(false);
                                setTab("install");
                              }}
                            >
                              <Download size={13} />
                              更多安装
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>

                {selectedIds.length > 0 && (
                  <SelectionToolbar
                    count={selectedIds.length}
                    folders={folders}
                    busy={Boolean(aiQueue?.running) || backupBusy}
                    pageIds={pageItems.map((s) => s.id)}
                    onSelectPage={() => {
                      setSelectMode(true);
                      setSelectedIds((prev) => {
                        const set = new Set(prev);
                        for (const s of pageItems) set.add(s.id);
                        return [...set];
                      });
                    }}
                    onClear={() => {
                      setSelectedIds([]);
                      setSelectMode(false);
                    }}
                    onMoveFolder={(folderId) => void batchMoveFolder(folderId)}
                    onAddTag={(tag) => void batchAddTag(tag)}
                    onGenZh={() => void batchGen(["zh"])}
                    onGenCover={() => void batchGen(["cover"])}
                    onDelete={() => void batchDelete()}
                  />
                )}
              </header>

              {allTags.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[11px] font-semibold text-panel-muted">标签</span>
                  {allTags.map((tag) => {
                    const on = selectedTags.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => toggleTagFilter(tag)}
                        aria-pressed={on}
                        className={cn(
                          "rounded-full px-2.5 py-1 text-[11px] font-medium transition",
                          on
                            ? "bg-panel-accent text-white shadow-soft"
                            : "bg-white/80 text-panel-muted hover:bg-white hover:text-panel-ink"
                        )}
                      >
                        {tag}
                      </button>
                    );
                  })}
                  {selectedTags.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedTags([])}
                      className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-panel-muted hover:text-panel-ink"
                    >
                      清除
                    </button>
                  )}
                </div>
              )}

              {outdatedUpdates.length > 0 && (
                <div className="mb-3 rounded-[18px] border border-sky-200/80 bg-sky-50/90 px-3.5 py-2.5 text-[12px] text-sky-950">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span>
                      发现 {outdatedUpdates.length} 个可更新
                      {outdatedUpdates.some((u) => u.local_modified)
                        ? `（含 ${outdatedUpdates.filter((u) => u.local_modified).length} 个本地已改）`
                        : ""}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void applyAllUpdates()}
                      className="rounded-full bg-panel-accent px-3 py-1 font-semibold text-white disabled:opacity-50"
                    >
                      全部更新
                    </button>
                    <button
                      type="button"
                      onClick={() => setOutdatedUpdates([])}
                      className="rounded-full bg-white px-3 py-1 font-semibold text-sky-900 shadow-inset"
                    >
                      关闭
                    </button>
                  </div>
                  <ul className="max-h-28 space-y-1 overflow-auto">
                    {outdatedUpdates.map((u) => (
                      <li key={u.skill_id} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {u.name}
                          {u.local_modified ? (
                            <span className="ml-1.5 text-[10px] font-semibold text-amber-700">
                              本地已改
                            </span>
                          ) : null}
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void applyOneUpdate(u.skill_id)}
                          className="shrink-0 rounded-full bg-white px-2.5 py-0.5 font-semibold text-sky-900 shadow-inset disabled:opacity-50"
                        >
                          更新
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {duplicateGroupCount > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[18px] border border-amber-200/80 bg-amber-50/90 px-3.5 py-2.5 text-[12px] text-amber-900">
                  <span>
                    检测到 {duplicateGroupCount} 组相似技能
                    {collapseDupes ? `，已折叠显示（隐藏 ${duplicateSkillCount} 个副本）` : "，当前已全部展开"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCollapseDupes((v) => !v)}
                    className="rounded-full bg-white px-3 py-1 font-semibold text-amber-900 shadow-inset"
                  >
                    {collapseDupes ? "展开全部" : "折叠相似"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void cleanDuplicates()}
                    className="rounded-full bg-panel-accent px-3 py-1 font-semibold text-white disabled:opacity-50"
                  >
                    清理重复副本
                  </button>
                </div>
              )}

              {busy && skills.length === 0 ? (
                <SkillGridSkeleton cols={cols} rows={rows} />
              ) : visibleSkills.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center rounded-card border border-dashed border-panel-line bg-white/50 text-panel-muted ui-fade-in">
                  <div className="mb-3 skill-sheen h-16 w-28 rounded-[18px] shadow-soft" />
                  {skills.length === 0 ? (
                    <>
                      <p className="mb-2 font-sans text-[22px] text-panel-ink">这里还没有技能</p>
                      <p className="mb-4 text-[12px]">选技能库上级目录即可批量导入，或拖拽进来</p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void quickImport()}
                        className="rounded-full bg-panel-accent px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
                      >
                        批量导入本地 Skill
                      </button>
                    </>
                  ) : hideNative &&
                    nativeCount > 0 &&
                    baseSkills.length === 0 &&
                    !onlyLocalModified &&
                    !query.trim() &&
                    selectedTags.length === 0 &&
                    folderFilter === "all" ? (
                    <>
                      <p className="mb-2 font-sans text-[22px] text-panel-ink">原生技能已隐藏</p>
                      <p className="mb-4 text-[12px]">左侧筛选可显示原生，或一键导入更多技能</p>
                      <div className="flex flex-wrap justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => setHideNative(false)}
                          className="rounded-full bg-panel-accent px-5 py-2.5 text-[13px] font-semibold text-white"
                        >
                          显示原生技能
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void quickImport()}
                          className="glass-pill px-5 py-2.5 text-[13px] font-semibold text-panel-ink disabled:opacity-50"
                        >
                          一键导入
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="mb-2 font-sans text-[22px] text-panel-ink">没有匹配的技能</p>
                      <p className="mb-4 max-w-sm text-center text-[12px]">
                        当前筛选或搜索没有结果，试试清空条件
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setQuery("");
                          setSelectedTags([]);
                          setFolderFilter("all");
                          setOnlyLocalModified(false);
                        }}
                        className="rounded-full bg-panel-accent px-5 py-2.5 text-[13px] font-semibold text-white"
                      >
                        清空筛选
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div
                    ref={gridRef}
                    className="grid min-h-0 flex-1 gap-3 overflow-hidden"
                    style={{
                      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                      gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
                    }}
                  >
                    {pageItems.map((skill, index) => (
                      <SkillCardView
                        key={skill.id}
                        skill={skill}
                        tone={index}
                        duplicateCount={collapseDupes ? dupCountById[skill.id] || 0 : 0}
                        onShowDuplicates={() => revealDuplicates(skill.id)}
                        hasUpdate={outdatedIdSet.has(skill.id)}
                        onApply={() => onApply(skill, false)}
                        onCopyOnly={() => onApply(skill, true)}
                        onTogglePin={async () => setSkills(await api.togglePin(skill.id))}
                        onSaveZh={(text) => onSaveZh(skill, text)}
                        onSaveDisplayName={(name) => onSaveDisplayName(skill, name)}
                        onSaveTags={(tags) => onSaveTags(skill, tags)}
                        onOpenDetail={() => setDetailSkillId(skill.id)}
                        onSetCover={() => void onSetCover(skill)}
                        onClearCover={() => void onClearCover(skill)}
                        onDelete={() => requestDeleteSkill(skill)}
                        onGenerateZh={() => requestGenerateZh(skill)}
                        onGenerateCover={() => requestGenerateCover(skill)}
                        onPointerDragStart={beginSkillPointerDrag}
                        isPointerDragging={skillDrag?.skillId === skill.id}
                        selected={selectedIds.includes(skill.id)}
                        selectMode={selectMode}
                        onToggleSelect={toggleSelect}
                        generatingZh={
                          (aiBusy?.skillId === skill.id && aiBusy.kind === "zh") ||
                          Boolean(
                            aiQueue?.active.some((j) => j.skillId === skill.id && j.kind === "zh")
                          )
                        }
                        generatingCover={
                          (aiBusy?.skillId === skill.id && aiBusy.kind === "cover") ||
                          Boolean(
                            aiQueue?.active.some(
                              (j) => j.skillId === skill.id && j.kind === "cover"
                            )
                          )
                        }
                      />
                    ))}
                  </div>

                  <PaginationBar
                    page={safePage}
                    totalPages={totalPages}
                    totalItems={visibleSkills.length}
                    onChange={setPage}
                  />
                </>
              )}
            </>
          )}

          {tab === "install" && (
            <div className="mx-auto w-full max-w-3xl space-y-4 overflow-auto">
              <div>
                <h1 className="font-sans text-[34px] font-semibold tracking-[-0.03em]">安装 Skills</h1>
                <p className="mt-2 text-[13px] text-panel-muted">本地 / Git / skills.sh 风格来源</p>
              </div>

              <section className="rounded-card border border-white/80 bg-white/80 p-5 shadow-soft">
                <div className="mb-3 flex items-center gap-2 font-semibold">
                  <FolderOpen size={16} aria-hidden="true" /> 本地导入
                </div>
                <p className="mb-3 text-[12px] text-panel-muted">
                  选 skills 库目录可批量导入；若某个包本身含多个子 skill，会保留为一个技能。也支持多选、拖拽、粘贴路径。
                </p>
                <div className="mb-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void quickImport()}
                    className="rounded-full bg-panel-accent px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
                  >
                    批量导入目录
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void installLocalFile()}
                    className="glass-pill px-4 py-2.5 text-[13px] font-semibold text-panel-ink disabled:opacity-50"
                  >
                    选择文件
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    value={localPath}
                    onChange={(e) => setLocalPath(e.target.value)}
                    placeholder={PATH_PLACEHOLDER}
                    aria-label="本地路径"
                    className="min-w-0 flex-1 rounded-2xl bg-panel-soft/80 px-4 py-3 text-[13px] outline-none"
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void installLocalPath()}
                    className="shrink-0 rounded-full bg-panel-accent px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
                  >
                    导入路径
                  </button>
                </div>
              </section>

              <section className="rounded-card border border-white/80 bg-white/80 p-5 shadow-soft">
                <div className="mb-3 flex items-center gap-2 font-semibold">
                  <GitBranch size={16} aria-hidden="true" /> Git 安装
                </div>
                <input
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="https://github.com/org/repo.git 或 org/repo"
                  aria-label="Git 仓库地址"
                  disabled={gitInstallKind === "git"}
                  className="mb-2 w-full rounded-2xl bg-panel-soft/80 px-4 py-3 text-[13px] outline-none disabled:opacity-60"
                />
                <input
                  value={gitSubpath}
                  onChange={(e) => setGitSubpath(e.target.value)}
                  placeholder="可选：只装其中一个，如 skills/productivity/grill-me"
                  aria-label="Git 子路径"
                  disabled={gitInstallKind === "git"}
                  className="mb-3 w-full rounded-2xl bg-panel-soft/80 px-4 py-3 text-[13px] outline-none disabled:opacity-60"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!!gitInstallKind}
                    onClick={() => void installGit()}
                    className="rounded-full bg-panel-accent px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
                  >
                    {gitInstallKind === "git"
                      ? `安装中 ${installProgress?.percent ?? 0}%`
                      : "从 Git 安装"}
                  </button>
                  {gitInstallKind === "git" && (
                    <button
                      type="button"
                      onClick={() => void cancelGitInstall()}
                      className="rounded-full bg-white px-4 py-2.5 text-[13px] font-semibold text-panel-ink shadow-inset"
                    >
                      取消
                    </button>
                  )}
                </div>
                {gitInstallKind === "git" && installProgress && (
                  <div className="mt-3 rounded-2xl border border-panel-line/80 bg-panel-soft/50 p-3">
                    <div className="mb-1.5 flex items-center justify-between gap-2 text-[12px]">
                      <span className="min-w-0 truncate font-medium text-panel-ink">
                        {installProgress.message || "安装中…"}
                      </span>
                      <span className="shrink-0 font-en text-panel-muted">
                        {installProgress.percent}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/80">
                      <div
                        className="h-full rounded-full bg-panel-accent transition-[width] duration-300 ease-out"
                        style={{ width: `${Math.max(4, installProgress.percent)}%` }}
                      />
                    </div>
                  </div>
                )}
              </section>

              <section className="rounded-card border border-white/80 bg-white/80 p-5 shadow-soft">
                <div className="mb-3 flex items-center gap-2 font-semibold">
                  <Store size={16} aria-hidden="true" /> skills.sh / GitHub 源
                </div>
                <div className="mb-2 grid gap-2 md:grid-cols-2">
                  <input
                    value={sshSource}
                    onChange={(e) => setSshSource(e.target.value)}
                    placeholder="source，如 vercel-labs/agent-skills"
                    aria-label="skills.sh source"
                    disabled={gitInstallKind === "market"}
                    className="rounded-2xl bg-panel-soft/80 px-4 py-3 text-[13px] outline-none disabled:opacity-60"
                  />
                  <input
                    value={sshSkill}
                    onChange={(e) => setSshSkill(e.target.value)}
                    placeholder="skill id，如 react-best-practices"
                    aria-label="skill id"
                    disabled={gitInstallKind === "market"}
                    className="rounded-2xl bg-panel-soft/80 px-4 py-3 text-[13px] outline-none disabled:opacity-60"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!!gitInstallKind}
                    onClick={() => void installMarket()}
                    className="rounded-full bg-panel-accent px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
                  >
                    {gitInstallKind === "market"
                      ? `安装中 ${installProgress?.percent ?? 0}%`
                      : "安装"}
                  </button>
                  {gitInstallKind === "market" && (
                    <button
                      type="button"
                      onClick={() => void cancelGitInstall()}
                      className="rounded-full bg-white px-4 py-2.5 text-[13px] font-semibold text-panel-ink shadow-inset"
                    >
                      取消
                    </button>
                  )}
                </div>
                {gitInstallKind === "market" && installProgress && (
                  <div className="mt-3 rounded-2xl border border-panel-line/80 bg-panel-soft/50 p-3">
                    <div className="mb-1.5 flex items-center justify-between gap-2 text-[12px]">
                      <span className="min-w-0 truncate font-medium text-panel-ink">
                        {installProgress.message || "安装中…"}
                      </span>
                      <span className="shrink-0 font-en text-panel-muted">
                        {installProgress.percent}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/80">
                      <div
                        className="h-full rounded-full bg-panel-accent transition-[width] duration-300 ease-out"
                        style={{ width: `${Math.max(4, installProgress.percent)}%` }}
                      />
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}

          {tab === "settings" && (
            <div className="mx-auto w-full max-w-2xl space-y-4 overflow-auto pb-8">
              <div>
                <h1 className="font-sans text-[34px] font-semibold tracking-[-0.03em]">设置</h1>
                <p className="mt-2 text-[13px] text-panel-muted">路径、部署目标与 AI 生成</p>
              </div>
              <section className="rounded-card border border-white/80 bg-white/80 p-5 shadow-soft">
                <div className="mb-2 text-[13px] text-panel-muted">中央库路径</div>
                <div className="rounded-2xl bg-panel-soft/80 px-4 py-3 font-en text-[12px]">
                  {libraryPath || "~/.skill-panel/skills"}
                </div>
              </section>
              <section className="space-y-3 rounded-card border border-white/80 bg-white/80 p-5 shadow-soft">
                <div>
                  <label className="mb-2 block text-[13px] text-panel-muted" htmlFor="cursor-dir">
                    Cursor skills 目录（留空用默认）
                  </label>
                  <input
                    id="cursor-dir"
                    value={cursorDir}
                    onChange={(e) => setCursorDir(e.target.value)}
                    placeholder="%USERPROFILE%\.cursor\skills"
                    className="w-full rounded-2xl bg-panel-soft/80 px-4 py-3 text-[13px] outline-none"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-[13px] text-panel-muted" htmlFor="codex-dir">
                    Codex skills 目录（留空用默认）
                  </label>
                  <input
                    id="codex-dir"
                    value={codexDir}
                    onChange={(e) => setCodexDir(e.target.value)}
                    placeholder="%USERPROFILE%\.codex\skills"
                    className="w-full rounded-2xl bg-panel-soft/80 px-4 py-3 text-[13px] outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void saveSettings()}
                  className="rounded-full bg-panel-accent px-4 py-2.5 text-[13px] font-semibold text-white"
                >
                  保存路径
                </button>
              </section>

              <section className="space-y-3 rounded-card border border-white/80 bg-white/80 p-5 shadow-soft">
                <div>
                  <h2 className="text-[15px] font-semibold tracking-[-0.02em]">AI 生成</h2>
                  <p className="mt-1 text-[12px] text-panel-muted">
                    文字与图像可分开配置；保存在 ~/.skill-panel/ai.json
                  </p>
                </div>

                <div className="overflow-hidden rounded-2xl bg-panel-soft/40">
                  <button
                    type="button"
                    onClick={() => setAiTextOpen((v) => !v)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold">文字（简介 / 封面提示词）</div>
                      <div className="mt-0.5 truncate text-[11px] text-panel-muted">
                        {textPreset === "custom"
                          ? "自定义"
                          : TEXT_PRESETS[textPreset].label}{" "}
                        · {textModel || "未设模型"} · {textKeySet ? `Key ${textKeyHint}` : "未设 Key"}
                      </div>
                    </div>
                    <ChevronDown
                      size={16}
                      className={cn(
                        "shrink-0 text-panel-muted transition duration-200",
                        aiTextOpen && "rotate-180"
                      )}
                    />
                  </button>
                  {aiTextOpen && (
                    <div className="space-y-3 border-t border-white/60 px-4 py-3 ui-fade-in">
                      <p className="text-[11px] leading-5 text-panel-muted">
                        OpenAI 兼容 `/chat/completions`，DeepSeek / Kimi / 中转均可。
                      </p>
                      <div>
                        <label className="mb-2 block text-[13px] text-panel-muted" htmlFor="text-preset">
                          快捷预设
                        </label>
                        <select
                          id="text-preset"
                          value={textPreset}
                          onChange={(e) => applyTextPreset(e.target.value as TextPresetId)}
                          className="w-full rounded-2xl bg-white/80 px-4 py-3 text-[13px] outline-none"
                        >
                          {(Object.keys(TEXT_PRESETS) as Exclude<TextPresetId, "custom">[]).map(
                            (id) => (
                              <option key={id} value={id}>
                                {TEXT_PRESETS[id].label}
                              </option>
                            )
                          )}
                          <option value="custom">自定义</option>
                        </select>
                      </div>
                      <div>
                        <label className="mb-2 block text-[13px] text-panel-muted" htmlFor="text-key">
                          API Key
                          {textKeySet && (
                            <span className="ml-2 font-en text-[11px] text-panel-muted/80">
                              已保存 {textKeyHint}
                            </span>
                          )}
                        </label>
                        <input
                          id="text-key"
                          type="password"
                          value={textKeyDraft}
                          onChange={(e) => setTextKeyDraft(e.target.value)}
                          placeholder={textKeySet ? "留空保持现有 Key" : "粘贴文字模型 API Key"}
                          className="w-full rounded-2xl bg-white/80 px-4 py-3 font-en text-[13px] outline-none"
                          autoComplete="off"
                        />
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label
                            className="mb-2 block text-[13px] text-panel-muted"
                            htmlFor="text-base"
                          >
                            Base URL
                          </label>
                          <input
                            id="text-base"
                            value={textBaseUrl}
                            onChange={(e) => {
                              setTextBaseUrl(e.target.value);
                              setTextPreset("custom");
                            }}
                            className="w-full rounded-2xl bg-white/80 px-4 py-3 font-en text-[12px] outline-none"
                          />
                        </div>
                        <div>
                          <label
                            className="mb-2 block text-[13px] text-panel-muted"
                            htmlFor="text-model"
                          >
                            模型
                          </label>
                          <input
                            id="text-model"
                            value={textModel}
                            onChange={(e) => {
                              setTextModel(e.target.value);
                              setTextPreset("custom");
                            }}
                            className="w-full rounded-2xl bg-white/80 px-4 py-3 font-en text-[12px] outline-none"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="overflow-hidden rounded-2xl bg-panel-soft/40">
                  <button
                    type="button"
                    onClick={() => setAiImageOpen((v) => !v)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold">图像（封面）</div>
                      <div className="mt-0.5 truncate text-[11px] text-panel-muted">
                        {imageProvider === "openai" ? "OpenAI Images" : "GrsAI"} ·{" "}
                        {imageModel || "未设模型"} ·{" "}
                        {imageKeySet ? `Key ${imageKeyHint}` : "未设 Key"}
                      </div>
                    </div>
                    <ChevronDown
                      size={16}
                      className={cn(
                        "shrink-0 text-panel-muted transition duration-200",
                        aiImageOpen && "rotate-180"
                      )}
                    />
                  </button>
                  {aiImageOpen && (
                    <div className="space-y-3 border-t border-white/60 px-4 py-3 ui-fade-in">
                      <div>
                        <label
                          className="mb-2 block text-[13px] text-panel-muted"
                          htmlFor="image-provider"
                        >
                          出图协议
                        </label>
                        <select
                          id="image-provider"
                          value={imageProvider}
                          onChange={(e) => switchImageProvider(e.target.value as AiProvider)}
                          className="w-full rounded-2xl bg-white/80 px-4 py-3 text-[13px] outline-none"
                        >
                          <option value="grsai">GrsAI（异步出图）</option>
                          <option value="openai">OpenAI 兼容 Images</option>
                        </select>
                        <p className="mt-1.5 text-[11px] leading-5 text-panel-muted">
                          {IMAGE_PRESETS[imageProvider].hint}
                        </p>
                      </div>
                      <div>
                        <label
                          className="mb-2 block text-[13px] text-panel-muted"
                          htmlFor="image-key"
                        >
                          API Key
                          {imageKeySet && (
                            <span className="ml-2 font-en text-[11px] text-panel-muted/80">
                              已保存 {imageKeyHint}
                            </span>
                          )}
                        </label>
                        <input
                          id="image-key"
                          type="password"
                          value={imageKeyDraft}
                          onChange={(e) => setImageKeyDraft(e.target.value)}
                          placeholder={
                            imageKeySet
                              ? "留空保持现有 Key"
                              : imageProvider === "openai"
                                ? "粘贴 OpenAI / 出图中转 Key"
                                : "粘贴 GrsAI API Key"
                          }
                          className="w-full rounded-2xl bg-white/80 px-4 py-3 font-en text-[13px] outline-none"
                          autoComplete="off"
                        />
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label
                            className="mb-2 block text-[13px] text-panel-muted"
                            htmlFor="image-base"
                          >
                            Base URL
                          </label>
                          <input
                            id="image-base"
                            value={imageBaseUrl}
                            onChange={(e) => setImageBaseUrl(e.target.value)}
                            placeholder={IMAGE_PRESETS[imageProvider].base_url}
                            className="w-full rounded-2xl bg-white/80 px-4 py-3 font-en text-[12px] outline-none"
                          />
                        </div>
                        <div>
                          <label
                            className="mb-2 block text-[13px] text-panel-muted"
                            htmlFor="image-model"
                          >
                            模型
                          </label>
                          <input
                            id="image-model"
                            value={imageModel}
                            onChange={(e) => setImageModel(e.target.value)}
                            placeholder={IMAGE_PRESETS[imageProvider].model}
                            className="w-full rounded-2xl bg-white/80 px-4 py-3 font-en text-[12px] outline-none"
                          />
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label
                            className="mb-2 block text-[13px] text-panel-muted"
                            htmlFor="ai-aspect"
                          >
                            封面比例
                          </label>
                          <select
                            id="ai-aspect"
                            value={aiImageAspect}
                            onChange={(e) => setAiImageAspect(e.target.value)}
                            className="w-full rounded-2xl bg-white/80 px-3 py-2.5 font-en text-[12px] outline-none"
                          >
                            <option value="16:9">16:9</option>
                            <option value="3:2">3:2</option>
                            <option value="4:3">4:3</option>
                            <option value="1:1">1:1</option>
                            <option value="9:16">9:16</option>
                          </select>
                        </div>
                        {imageProvider === "grsai" && (
                          <div>
                            <label
                              className="mb-2 block text-[13px] text-panel-muted"
                              htmlFor="ai-resolution"
                            >
                              出图分辨率
                            </label>
                            <select
                              id="ai-resolution"
                              value={aiImageResolution}
                              onChange={(e) => setAiImageResolution(e.target.value)}
                              className="w-full rounded-2xl bg-white/80 px-3 py-2.5 font-en text-[12px] outline-none"
                            >
                              <option value="4K">4K</option>
                              <option value="2K">2K</option>
                              <option value="1K">1K</option>
                            </select>
                          </div>
                        )}
                      </div>
                      <p className="text-[11px] leading-5 text-panel-muted">
                        封面提示词由文字通道生成，再交出图通道；入库自动压缩（约 ≤160KB JPEG）。
                      </p>
                    </div>
                  )}
                </div>

                <div className="overflow-hidden rounded-2xl bg-panel-soft/40">
                  <button
                    type="button"
                    onClick={() => setAiPromptsOpen((v) => !v)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold">系统提示词</div>
                      <div className="mt-0.5 text-[11px] text-panel-muted">
                        简介与封面 Prompt（默认折叠）
                      </div>
                    </div>
                    <ChevronDown
                      size={16}
                      className={cn(
                        "shrink-0 text-panel-muted transition duration-200",
                        aiPromptsOpen && "rotate-180"
                      )}
                    />
                  </button>
                  {aiPromptsOpen && (
                    <div className="space-y-3 border-t border-white/60 px-4 py-3 ui-fade-in">
                      <div>
                        <label
                          className="mb-2 block text-[13px] text-panel-muted"
                          htmlFor="ai-prompt-text"
                        >
                          简介系统提示词
                        </label>
                        <textarea
                          id="ai-prompt-text"
                          value={aiPromptText}
                          onChange={(e) => setAiPromptText(e.target.value)}
                          rows={8}
                          className="w-full resize-y rounded-2xl bg-white/80 px-4 py-3 text-[12px] leading-5 outline-none"
                        />
                      </div>
                      <div>
                        <label
                          className="mb-2 block text-[13px] text-panel-muted"
                          htmlFor="ai-prompt-image"
                        >
                          封面 Prompt 系统提示词
                        </label>
                        <textarea
                          id="ai-prompt-image"
                          value={aiPromptImage}
                          onChange={(e) => setAiPromptImage(e.target.value)}
                          rows={8}
                          className="w-full resize-y rounded-2xl bg-white/80 px-4 py-3 text-[12px] leading-5 outline-none"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2 border-t border-panel-line/60 pt-3">
                  <button
                    type="button"
                    disabled={savingAi}
                    onClick={() => void saveAiSettings()}
                    className="rounded-full bg-panel-accent px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
                  >
                    {savingAi ? "保存中…" : "保存 AI 设置"}
                  </button>
                  <button
                    type="button"
                    disabled={testingAi}
                    onClick={() => void testAiConnection()}
                    className="rounded-full bg-panel-soft px-4 py-2.5 text-[13px] font-semibold text-panel-ink disabled:opacity-50"
                  >
                    {testingAi ? "测试中…" : "测试文字连接"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void resetAiPrompts()}
                    className="rounded-full bg-panel-soft px-4 py-2.5 text-[13px] font-semibold text-panel-ink"
                  >
                    恢复默认提示词
                  </button>
                </div>
              </section>

              <section className="space-y-3 rounded-card border border-white/80 bg-white/80 p-5 shadow-soft">
                <div>
                  <h2 className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-[-0.02em]">
                    <Archive size={16} aria-hidden="true" />
                    备份与恢复
                  </h2>
                  <p className="mt-1 text-[12px] text-panel-muted">
                    导出 skills / meta / 生成封面 / ai 配置（不含 API Key）；换机恢复后封面会一并还原。恢复可选替换或合并跳过。新生成封面会自动压到约 160KB 内；已有大图可点下方压缩。
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={backupBusy}
                    onClick={() => void exportBackup(false)}
                    className="rounded-full bg-panel-accent px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
                  >
                    导出 ZIP
                  </button>
                  <button
                    type="button"
                    disabled={backupBusy}
                    onClick={() => void exportBackup(true)}
                    className="rounded-full bg-panel-soft px-4 py-2.5 text-[13px] font-semibold text-panel-ink disabled:opacity-50"
                  >
                    导出文件夹
                  </button>
                  <button
                    type="button"
                    disabled={backupBusy}
                    onClick={() => void pickRestore()}
                    className="rounded-full bg-panel-soft px-4 py-2.5 text-[13px] font-semibold text-panel-ink disabled:opacity-50"
                  >
                    从备份恢复…
                  </button>
                  <button
                    type="button"
                    disabled={backupBusy}
                    onClick={() => void recompressCovers()}
                    className="rounded-full bg-panel-soft px-4 py-2.5 text-[13px] font-semibold text-panel-ink disabled:opacity-50"
                  >
                    压缩已有封面
                  </button>
                </div>
              </section>
            </div>
          )}
        </main>
      </div>

      {skillDrag && (
        <div
          className="pointer-events-none fixed z-[70] max-w-[220px] truncate rounded-full bg-panel-accent px-3 py-1.5 text-[12px] font-semibold text-white shadow-float"
          style={{ left: skillDrag.x + 12, top: skillDrag.y + 12 }}
        >
          {skillDrag.title}
        </div>
      )}

      {restoreConfirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          onClick={() => !backupBusy && setRestoreConfirm(null)}
        >
          <div
            className="w-full max-w-md rounded-[22px] border border-white/80 bg-white p-5 shadow-float"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-[18px] font-semibold tracking-[-0.02em]">如何恢复备份？</h2>
            <p className="mt-2 break-all text-[12px] text-panel-muted">{restoreConfirm}</p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={backupBusy}
                onClick={() => setRestoreConfirm(null)}
                className="rounded-full bg-panel-soft px-4 py-2.5 text-[13px] font-semibold disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={backupBusy}
                onClick={() => void confirmRestore("merge_skip")}
                className="rounded-full bg-panel-soft px-4 py-2.5 text-[13px] font-semibold disabled:opacity-50"
              >
                合并（跳过同名）
              </button>
              <button
                type="button"
                disabled={backupBusy}
                onClick={() => void confirmRestore("replace")}
                className="rounded-full bg-rose-600 px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
              >
                整库替换
              </button>
            </div>
          </div>
        </div>
      )}

      {aiConfirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ai-overwrite-title"
          onClick={() => {
            if (!aiBusy) setAiConfirm(null);
          }}
        >
          <div
            className="w-full max-w-md rounded-[22px] border border-white/80 bg-white p-5 shadow-float"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="ai-overwrite-title" className="text-[18px] font-semibold tracking-[-0.02em]">
              {aiConfirm.kind === "zh" ? "覆盖中文简介？" : "覆盖现有封面？"}
            </h2>
            <p className="mt-2 text-[13px] leading-6 text-panel-muted">
              「
              <span className="font-semibold text-panel-ink">
                {aiConfirm.skill.display_name || aiConfirm.skill.name}
              </span>
              」已有
              {aiConfirm.kind === "zh" ? "中文简介" : "封面"}
              ，继续将用 AI 结果替换。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={Boolean(aiBusy)}
                onClick={() => setAiConfirm(null)}
                className="rounded-full bg-panel-soft px-4 py-2.5 text-[13px] font-semibold text-panel-ink disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={Boolean(aiBusy)}
                onClick={() => confirmAiGenerate()}
                className="rounded-full bg-panel-accent px-4 py-2.5 text-[13px] font-semibold text-white shadow-soft disabled:opacity-50"
              >
                {aiBusy ? "生成中…" : "确认覆盖"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmSkill && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-skill-title"
          onClick={cancelDeleteSkill}
        >
          <div
            className="w-full max-w-md rounded-[22px] border border-white/80 bg-white p-5 shadow-float"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="delete-skill-title" className="text-[18px] font-semibold tracking-[-0.02em]">
              确认删除技能？
            </h2>
            <p className="mt-2 text-[13px] leading-6 text-panel-muted">
              将永久删除「
              <span className="font-semibold text-panel-ink">
                {deleteConfirmSkill.display_name || deleteConfirmSkill.name}
              </span>
              」及其面板库中的本地文件。此操作不可撤销。
            </p>
            <p className="mt-2 truncate font-en text-[11px] text-panel-muted/80">
              {deleteConfirmSkill.invoke} · {deleteConfirmSkill.id}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={deletingSkill}
                onClick={cancelDeleteSkill}
                className="rounded-full bg-panel-soft px-4 py-2.5 text-[13px] font-semibold text-panel-ink disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={deletingSkill}
                onClick={() => void confirmDeleteSkill()}
                className="rounded-full bg-rose-600 px-4 py-2.5 text-[13px] font-semibold text-white shadow-soft disabled:opacity-50"
              >
                {deletingSkill ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}

      {(aiBusy || aiQueue?.running) && !toast && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "fixed z-[60] w-[min(440px,calc(100%-2rem))] rounded-2xl border border-white/10 bg-[#1c1f27] px-4 py-3.5 text-[13px] font-medium text-white shadow-[0_18px_40px_rgba(28,31,39,0.35)]",
            "bottom-6 left-1/2 -translate-x-1/2"
          )}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-white">
              {aiProgress?.message ||
                (aiQueue?.running
                  ? `队列运行中：进行 ${aiQueue.active.length} · 等待 ${aiQueue.pending.length} · 完成 ${aiQueue.done}`
                  : aiBusy?.kind === "zh"
                    ? "后台生成简介中，可继续操作…"
                    : "后台生成封面中，可继续操作…")}
            </span>
            <span className="shrink-0 font-en text-[12px] font-semibold tabular-nums text-white/90">
              {aiProgress?.percent ?? 0}%
            </span>
          </div>
          <div className="mb-2.5 h-2 overflow-hidden rounded-full bg-white/20">
            <div
              className="h-full rounded-full bg-white transition-[width] duration-300"
              style={{ width: `${Math.max(8, aiProgress?.percent ?? 8)}%` }}
            />
          </div>
          <button
            type="button"
            onClick={() => void cancelAiAll()}
            className="rounded-full border border-white/25 bg-white/10 px-3 py-1 text-[11px] font-semibold text-white hover:bg-white/20"
          >
            取消全部
          </button>
        </div>
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-panel-accent px-5 py-2.5 text-[13px] font-medium text-white shadow-float"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

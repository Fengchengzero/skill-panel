import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
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
} from "lucide-react";
import {
  api,
  type AgentId,
  type Folder as SkillFolder,
  type SkillCard,
  type InstallProgress,
  type SkillUpdateInfo,
} from "./lib/api";
import { cn } from "./lib/cn";
import { groupSimilarSkills } from "./lib/similarity";
import { SkillCardView } from "./components/SkillCardView";
import { SkillDetailView } from "./components/SkillDetailView";
import { PaginationBar } from "./components/PaginationBar";

type Tab = "library" | "install" | "settings";
type FolderFilter = "all" | string;

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
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null);
  /** Git / market install only — does not block library or other actions */
  const [gitInstallKind, setGitInstallKind] = useState<"git" | "market" | null>(null);
  const gitInstallKindRef = useRef<"git" | "market" | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  gitInstallKindRef.current = gitInstallKind;
  const newFolderRef = useRef<HTMLInputElement>(null);
  const dialogOpenRef = useRef(false);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2800);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 文件对话框打开时不要把主窗口藏掉，否则用户会以为导入没反应
      if (dialogOpenRef.current) return;
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
  }, [detailSkillId]);

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
    if (!collapseDupes) return filtered;
    return skillGroups.map((g) => g.primary);
  }, [collapseDupes, filtered, skillGroups]);
  const dupCountById = useMemo(() => {
    const map: Record<string, number> = {};
    for (const g of skillGroups) {
      if (g.duplicates.length > 0) map[g.primary.id] = g.duplicates.length;
    }
    return map;
  }, [skillGroups]);

  useEffect(() => {
    setPage(0);
  }, [
    query,
    folderFilter,
    selectedTags,
    hideNative,
    onlyLocalModified,
    collapseDupes,
    visibleSkills.length,
  ]);

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

  const assignSkillToFolder = async (skillId: string, folderId: string | null) => {
    try {
      const list = await api.setSkillFolder(skillId, folderId);
      setSkills(list);
      const folderName =
        folderId == null ? "全部" : folders.find((f) => f.id === folderId)?.name || "分组";
      showToast(`已移到「${folderName}」`);
    } catch (e) {
      showToast(String(e));
    }
  };

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
      setGitInstallKind(null);
      setInstallProgress(null);
    }
  };

  const installMarket = async () => {
    if (!sshSource.trim() || !sshSkill.trim() || gitInstallKind) return;
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
    showToast("设置已保存");
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
        <div className="ml-6 border-l border-panel-line/80 py-1 pl-3 text-[10px] text-panel-muted/80">
          暂无技能
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
              <button
                type="button"
                onClick={() => {
                  setTab("library");
                  setDetailSkillId(null);
                  setFolderFilter("all");
                  setQuery("");
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverFolderId("all");
                }}
                onDragLeave={() => setDragOverFolderId((id) => (id === "all" ? null : id))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverFolderId(null);
                  const skillId =
                    e.dataTransfer.getData("application/x-skill-id") ||
                    e.dataTransfer.getData("text/plain");
                  if (skillId) void assignSkillToFolder(skillId, null);
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-2xl px-3 py-2.5 text-left transition",
                  dragOverFolderId === "all" && "ring-2 ring-panel-accent/40 bg-panel-mint/80",
                  folderFilter === "all" && tab === "library"
                    ? "bg-panel-accent text-white shadow-soft"
                    : "bg-panel-soft/80 text-panel-ink hover:bg-white"
                )}
              >
                <span className="text-[13px] font-semibold">全部技能</span>
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
                return (
                  <div
                    key={folder.id}
                    className={cn(
                      "rounded-2xl transition",
                      dragOverFolderId === folder.id && "bg-panel-mint/70 ring-2 ring-panel-accent/35",
                      active ? "bg-white shadow-inset" : "bg-transparent hover:bg-white/70"
                    )}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverFolderId(folder.id);
                    }}
                    onDragLeave={() =>
                      setDragOverFolderId((id) => (id === folder.id ? null : id))
                    }
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverFolderId(null);
                      const skillId =
                        e.dataTransfer.getData("application/x-skill-id") ||
                        e.dataTransfer.getData("text/plain");
                      if (skillId) void assignSkillToFolder(skillId, folder.id);
                    }}
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
                              {folder.name}
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
                  还没有文件夹，点此新建
                </button>
              )}
            </div>
          </section>

          <section className="mb-1.5 space-y-1 opacity-80">
            <div className="px-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-panel-muted/70">
              筛选
            </div>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => setHideNative((v) => !v)}
                aria-pressed={hideNative}
                title={hideNative ? "已隐藏原生技能" : "显示原生技能"}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium transition",
                  hideNative
                    ? "bg-white text-panel-ink shadow-inset"
                    : "text-panel-muted hover:bg-white/80"
                )}
              >
                {hideNative ? <EyeOff size={11} aria-hidden="true" /> : <Eye size={11} aria-hidden="true" />}
                原生 {nativeCount}
              </button>
              <button
                type="button"
                onClick={() => setCollapseDupes((v) => !v)}
                aria-pressed={collapseDupes}
                title={collapseDupes ? "已折叠相似技能" : "展开全部相似"}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium transition",
                  collapseDupes
                    ? "bg-white text-panel-ink shadow-inset"
                    : "text-panel-muted hover:bg-white/80"
                )}
              >
                <Layers size={11} aria-hidden="true" />
                相似 {duplicateSkillCount}
              </button>
              <button
                type="button"
                onClick={() => setOnlyLocalModified((v) => !v)}
                aria-pressed={onlyLocalModified}
                title={onlyLocalModified ? "仅看本地已改" : "筛选本地已改"}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium transition",
                  onlyLocalModified
                    ? "bg-amber-50 text-amber-900 shadow-inset"
                    : "text-panel-muted hover:bg-white/80"
                )}
              >
                <Pencil size={11} aria-hidden="true" />
                已改{" "}
                {skills.filter((s) => s.local_modified && (!hideNative || !s.is_native)).length}
              </button>
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
            <span>Ctrl+Shift+S</span>
            <span>Esc</span>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-panel-surface/55 p-6" id="main-content">
          {tab === "library" && detailSkill && (
            <SkillDetailView
              skill={detailSkill}
              folders={folders}
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
              onToast={showToast}
            />
          )}

          {tab === "library" && !detailSkill && (
            <>
              <header className="mb-4 flex shrink-0 flex-wrap items-end gap-4">
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

                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void checkUpdates()}
                    className="glass-pill inline-flex items-center gap-1.5 px-4 py-2.5 text-[12px] font-semibold text-panel-ink disabled:opacity-50"
                  >
                    <RefreshCcw size={14} aria-hidden="true" />
                    检查更新
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void quickImport()}
                    className="rounded-full bg-panel-accent px-4 py-2.5 text-[12px] font-semibold text-white shadow-soft disabled:opacity-50"
                  >
                    一键导入
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab("install")}
                    className="glass-pill px-4 py-2.5 text-[12px] font-semibold text-panel-ink"
                  >
                    更多安装
                  </button>
                  <div className="glass-pill flex min-w-[220px] items-center gap-2 px-4 py-2.5">
                    <Search size={15} className="text-panel-muted" aria-hidden="true" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="搜索技能"
                      aria-label="搜索技能"
                      className="w-full bg-transparent text-[13px] outline-none placeholder:text-panel-muted"
                    />
                  </div>
                </div>
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

              {visibleSkills.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center rounded-card border border-dashed border-panel-line bg-white/50 text-panel-muted">
                  <div className="mb-3 skill-sheen h-16 w-28 rounded-[18px] shadow-soft" />
                  <p className="mb-2 font-sans text-[22px] text-panel-ink">这里还没有技能</p>
                  <p className="mb-4 text-[12px]">
                    {hideNative && nativeCount > 0
                      ? "原生技能已隐藏，可在左侧筛选中显示，或一键导入"
                      : "选技能库上级目录即可批量导入，或拖拽进来"}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void quickImport()}
                    className="rounded-full bg-panel-accent px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
                  >
                    批量导入本地 Skill
                  </button>
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
                  直接选技能库上级目录即可批量导入，不用点进每个技能。也支持多选、拖拽、粘贴路径；相似会自动跳过。
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
                    placeholder="或粘贴路径，如 D:\\skills\\my-skill"
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
                  placeholder="可选子路径，如 skills/foo"
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
            <div className="mx-auto w-full max-w-2xl space-y-4 overflow-auto">
              <div>
                <h1 className="font-sans text-[34px] font-semibold tracking-[-0.03em]">设置</h1>
                <p className="mt-2 text-[13px] text-panel-muted">路径与部署目标</p>
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
                  保存
                </button>
              </section>
            </div>
          )}
        </main>
      </div>

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

import { invoke } from "@tauri-apps/api/core";

export type AgentId = "cursor" | "codex" | "chatgpt";

export interface SkillCard {
  id: string;
  name: string;
  /** Panel-only alias; equals folder id when unset. */
  display_name: string;
  description: string;
  description_zh: string;
  path: string;
  tags: string[];
  pinned: boolean;
  invoke: string;
  folder_id?: string | null;
  cover_path?: string | null;
  is_native?: boolean;
  local_modified?: boolean;
  /** Unix seconds of first import into the panel library. */
  imported_at?: number | null;
}

export interface Folder {
  id: string;
  name: string;
}

export interface MetaStore {
  tags: Record<string, string[]>;
  pinned: string[];
  folders?: Folder[];
  skill_folder?: Record<string, string>;
  covers?: Record<string, string>;
  description_zh?: Record<string, string>;
  display_names?: Record<string, string>;
  sources?: Record<string, string>;
  content_hashes?: Record<string, string>;
  cursor_skills_dir?: string | null;
  codex_skills_dir?: string | null;
}

export type UpdateStatus = "outdated" | "missing_source" | "source_gone" | "up_to_date";

export interface SkillUpdateInfo {
  skill_id: string;
  name: string;
  source_path?: string | null;
  status: UpdateStatus;
  local_modified?: boolean;
}

export interface UpdateApplyResult {
  updated: string[];
  errors: string[];
}

export interface ApplyResult {
  invoke: string;
  deployed_to?: string | null;
  expanded?: string[];
  pasted: boolean;
  message: string;
}

export interface NestedSkillInfo {
  rel_path: string;
  id: string;
  name: string;
  description: string;
  already_installed: boolean;
}

export interface AppPaths {
  root: string;
  skills: string;
  meta: string;
  covers: string;
}

export interface SkippedDuplicate {
  name: string;
  similar_to: string;
  reason: string;
}

export interface InstallResult {
  installed: string[];
  skipped: SkippedDuplicate[];
  errors?: string[];
}

export interface InstallProgress {
  stage: string;
  percent: number;
  message: string;
}

/** Image API wire format (text always uses OpenAI-compatible chat). */
export type AiProvider = "grsai" | "openai";

export interface AiSettingsPublic {
  text_base_url: string;
  text_model: string;
  text_api_key_set: boolean;
  text_api_key_hint: string;
  image_provider: AiProvider;
  image_base_url: string;
  image_model: string;
  image_api_key_set: boolean;
  image_api_key_hint: string;
  image_aspect: string;
  image_resolution: string;
  prompt_text: string;
  prompt_image: string;
}

export interface AiSettingsSave {
  text_api_key?: string | null;
  text_base_url: string;
  text_model: string;
  image_api_key?: string | null;
  image_provider: AiProvider;
  image_base_url: string;
  image_model: string;
  image_aspect: string;
  image_resolution: string;
  prompt_text: string;
  prompt_image: string;
}

export interface GenerateDescriptionResult {
  text: string;
  skills: SkillCard[];
}

export const api = {
  getPaths: () => invoke<AppPaths>("get_paths"),
  listSkills: () => invoke<SkillCard[]>("list_skills"),
  listTags: () => invoke<string[]>("list_tags"),
  listFolders: () => invoke<Folder[]>("list_folders"),
  createFolder: (name: string) => invoke<Folder[]>("create_folder", { name }),
  renameFolder: (folderId: string, name: string) =>
    invoke<Folder[]>("rename_folder", { folderId, name }),
  deleteFolder: (folderId: string) => invoke<Folder[]>("delete_folder", { folderId }),
  setSkillFolder: (skillId: string, folderId: string | null) =>
    invoke<SkillCard[]>("set_skill_folder", { skillId, folderId }),
  setSkillDescriptionZh: (skillId: string, text: string) =>
    invoke<SkillCard[]>("set_skill_description_zh", { skillId, text }),
  setSkillCover: (skillId: string, sourcePath: string) =>
    invoke<SkillCard[]>("set_skill_cover", { skillId, sourcePath }),
  pickAndSetSkillCover: (skillId: string) =>
    invoke<SkillCard[] | null>("pick_and_set_skill_cover", { skillId }),
  clearSkillCover: (skillId: string) =>
    invoke<SkillCard[]>("clear_skill_cover", { skillId }),
  setSkillTags: (skillId: string, tags: string[]) =>
    invoke<SkillCard[]>("set_skill_tags", { skillId, tags }),
  setSkillDisplayName: (skillId: string, name: string) =>
    invoke<SkillCard[]>("set_skill_display_name", { skillId, name }),
  readSkillMarkdown: (skillId: string) =>
    invoke<string>("read_skill_markdown", { skillId }),
  writeSkillMarkdown: (skillId: string, content: string) =>
    invoke<SkillCard[]>("write_skill_markdown", { skillId, content }),
  togglePin: (skillId: string) => invoke<SkillCard[]>("toggle_pin", { skillId }),
  deleteSkill: (skillId: string) => invoke<SkillCard[]>("delete_skill", { skillId }),
  getMeta: () => invoke<MetaStore>("get_meta"),
  saveMeta: (meta: MetaStore) => invoke<void>("save_meta", { meta }),
  applySkill: (
    skillId: string,
    agent: AgentId,
    copyOnly: boolean,
    autoPaste: boolean,
    expandNested = false
  ) =>
    invoke<ApplyResult>("apply_skill", {
      skillId,
      agent,
      copyOnly,
      autoPaste,
      expandNested,
    }),
  listNestedSkills: (skillId: string) =>
    invoke<NestedSkillInfo[]>("list_nested_skills", { skillId }),
  installNestedSkills: (skillId: string, relPaths: string[]) =>
    invoke<InstallResult>("install_nested_skills", { skillId, relPaths }),
  installLocal: (path: string, name?: string) =>
    invoke<InstallResult>("install_local", { path, name: name ?? null }),
  pickAndInstallLocal: () => invoke<InstallResult>("pick_and_install_local"),
  installGit: (repoUrl: string, subpath?: string) =>
    invoke<InstallResult>("install_git", { repoUrl, subpath: subpath ?? null }),
  installSkillssh: (source: string, skillId: string) =>
    invoke<InstallResult>("install_skillssh", { source, skillId }),
  cancelInstall: () => invoke<void>("cancel_install"),
  checkSkillUpdates: () => invoke<SkillUpdateInfo[]>("check_skill_updates"),
  updateSkill: (skillId: string) => invoke<SkillCard[]>("update_skill", { skillId }),
  updateSkills: (skillIds: string[]) =>
    invoke<UpdateApplyResult>("update_skills", { skillIds }),
  backfillSkillSources: () => invoke<number>("backfill_skill_sources"),
  openLibraryFolder: () => invoke<string>("open_library_folder"),
  getAiSettings: () => invoke<AiSettingsPublic>("get_ai_settings"),
  saveAiSettings: (settings: AiSettingsSave) =>
    invoke<AiSettingsPublic>("save_ai_settings", { settings }),
  resetAiPrompts: () => invoke<AiSettingsPublic>("reset_ai_prompts"),
  testAiConnection: () => invoke<string>("test_ai_connection"),
  cancelAi: () => invoke<void>("cancel_ai"),
  clearAiCancel: () => invoke<void>("clear_ai_cancel"),
  generateSkillDescription: (skillId: string) =>
    invoke<GenerateDescriptionResult>("generate_skill_description", { skillId }),
  generateSkillCover: (skillId: string) =>
    invoke<SkillCard[]>("generate_skill_cover", { skillId }),
  recompressCovers: () =>
    invoke<[CoverCompressResult, SkillCard[]]>("recompress_covers"),
  exportLibrary: (dest: string, asFolder: boolean) =>
    invoke<{ path: string; message: string }>("export_library", { dest, asFolder }),
  importLibrary: (source: string, mode: "replace" | "merge_skip") =>
    invoke<{ message: string; skills: SkillCard[] }>("import_library", { source, mode }),
};

export interface CoverCompressResult {
  scanned: number;
  compressed: number;
  skipped: number;
  bytes_before: number;
  bytes_after: number;
  message: string;
}

export interface AiProgress {
  kind: string;
  skill_id: string;
  stage: string;
  percent: number;
  message: string;
}

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillCard {
    pub id: String,
    pub name: String,
    /// Panel-only display alias; falls back to folder id when unset.
    #[serde(default)]
    pub display_name: String,
    pub description: String,
    pub description_zh: String,
    pub path: String,
    pub tags: Vec<String>,
    pub pinned: bool,
    pub invoke: String,
    pub folder_id: Option<String>,
    pub cover_path: Option<String>,
    /// Codex / Cursor 等软件自带技能（含重复导入的 -2/-3 后缀）
    #[serde(default)]
    pub is_native: bool,
    /// Local files edited after last sync from source
    #[serde(default)]
    pub local_modified: bool,
    /// Unix seconds when first imported into the panel library.
    #[serde(default)]
    pub imported_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MetaStore {
    pub tags: BTreeMap<String, Vec<String>>,
    pub pinned: BTreeSet<String>,
    #[serde(default)]
    pub folders: Vec<Folder>,
    /// skill_id -> folder_id
    #[serde(default)]
    pub skill_folder: BTreeMap<String, String>,
    /// skill_id -> cover path. Locally prefer absolute paths; backups may store filenames only.
    #[serde(default)]
    pub covers: BTreeMap<String, String>,
    /// skill_id -> Chinese description
    #[serde(default)]
    pub description_zh: BTreeMap<String, String>,
    /// skill_id -> display alias (does not rename folder / invoke)
    #[serde(default)]
    pub display_names: BTreeMap<String, String>,
    /// skill_id -> absolute import source path
    #[serde(default)]
    pub sources: BTreeMap<String, String>,
    /// skill_id -> content fingerprint at last import/update
    #[serde(default)]
    pub content_hashes: BTreeMap<String, String>,
    /// skill_ids edited locally after last source sync
    #[serde(default)]
    pub locally_edited: BTreeSet<String>,
    /// skill_id -> unix seconds of first import into panel
    #[serde(default)]
    pub imported_at: BTreeMap<String, u64>,
    pub cursor_skills_dir: Option<String>,
    pub codex_skills_dir: Option<String>,
}

pub fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Prefer FS created time; fall back to modified.
pub fn dir_birth_secs(path: &Path) -> Option<u64> {
    let meta = fs::metadata(path).ok()?;
    let t = meta.created().or_else(|_| meta.modified()).ok()?;
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
}

/// Record first-import time if missing. Does not overwrite existing.
pub fn touch_imported_at(meta: &mut MetaStore, skill_id: &str) {
    if meta.imported_at.contains_key(skill_id) {
        return;
    }
    meta.imported_at.insert(skill_id.to_string(), now_unix_secs());
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppPaths {
    pub root: String,
    pub skills: String,
    pub meta: String,
    pub covers: String,
}

pub fn home_dir() -> Result<PathBuf> {
    dirs::home_dir().context("Cannot resolve home directory")
}

pub fn root_dir() -> Result<PathBuf> {
    Ok(home_dir()?.join(".skill-panel"))
}

pub fn skills_dir() -> Result<PathBuf> {
    Ok(root_dir()?.join("skills"))
}

pub fn covers_dir() -> Result<PathBuf> {
    Ok(root_dir()?.join("covers"))
}

pub fn meta_path() -> Result<PathBuf> {
    Ok(root_dir()?.join("meta.json"))
}

pub fn ensure_library() -> Result<AppPaths> {
    let root = root_dir()?;
    let skills = skills_dir()?;
    let covers = covers_dir()?;
    let meta = meta_path()?;
    fs::create_dir_all(&skills)?;
    fs::create_dir_all(&covers)?;
    if !meta.exists() {
        save_meta(&MetaStore::default())?;
    }
    Ok(AppPaths {
        root: root.to_string_lossy().into_owned(),
        skills: skills.to_string_lossy().into_owned(),
        meta: meta.to_string_lossy().into_owned(),
        covers: covers.to_string_lossy().into_owned(),
    })
}

pub fn load_meta() -> Result<MetaStore> {
    ensure_library()?;
    let path = meta_path()?;
    let raw = fs::read_to_string(&path).unwrap_or_else(|_| "{}".into());
    match serde_json::from_str::<MetaStore>(&raw) {
        Ok(meta) => Ok(meta),
        Err(err) => {
            // Never silently clobber a corrupt meta with {} on next save.
            let bak = path.with_extension("json.parse-error.bak");
            let _ = fs::write(&bak, &raw);
            eprintln!("meta.json 解析失败，已备份到 {}: {err}", bak.display());
            Ok(MetaStore::default())
        }
    }
}

pub fn save_meta(meta: &MetaStore) -> Result<()> {
    let path = meta_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Atomic-ish write: temp then rename, avoid truncated meta on crash.
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(meta)?;
    fs::write(&tmp, raw)?;
    fs::rename(&tmp, &path).or_else(|_| {
        fs::copy(&tmp, &path)?;
        fs::remove_file(&tmp)
    })?;
    Ok(())
}

/// If `covers` meta is empty/broken but image files exist, rebuild absolute mappings.
pub fn repair_covers_from_disk(meta: &mut MetaStore) -> Result<bool> {
    ensure_library()?;
    let dir = covers_dir()?;
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(false);
    };
    let mut dirty = false;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let skill_id = name
            .rsplit_once('_')
            .and_then(|(id, rest)| {
                let stem = rest.rsplit_once('.').map(|(s, _)| s).unwrap_or(rest);
                if !stem.is_empty() && stem.chars().all(|c| c.is_ascii_digit()) {
                    Some(id.to_string())
                } else {
                    None
                }
            })
            .or_else(|| {
                Path::new(&name)
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
            })
            .unwrap_or(name);
        let abs = path.to_string_lossy().into_owned();
        match meta.covers.get(&skill_id) {
            Some(existing) if resolve_cover_abs(existing).is_some() => {}
            _ => {
                meta.covers.insert(skill_id, abs);
                dirty = true;
            }
        }
    }
    Ok(dirty)
}

/// True when `stored` looks like a path (absolute or with directories), not a bare filename.
fn cover_entry_is_path(stored: &str) -> bool {
    stored.contains('/') || stored.contains('\\') || Path::new(stored).is_absolute()
}

fn cover_basename(stored: &str) -> Option<String> {
    Path::new(stored)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
}

/// Resolve a meta cover entry to an absolute file path that exists.
/// Accepts portable filenames (`skill_123.jpg`) and legacy absolute paths.
pub fn resolve_cover_abs(stored: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(stored);
    if direct.is_file() {
        return Some(direct);
    }
    let name = cover_basename(stored)?;
    let candidate = covers_dir().ok()?.join(name);
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

/// Prefer the newest `skill_id_*` / `skill_id.*` file under covers/.
fn find_cover_file_for_skill(skill_id: &str) -> Option<PathBuf> {
    let dir = covers_dir().ok()?;
    let prefix_dot = format!("{skill_id}.");
    let prefix_us = format!("{skill_id}_");
    let mut best: Option<(u64, PathBuf)> = None;
    let entries = fs::read_dir(&dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !(name.starts_with(&prefix_dot) || name.starts_with(&prefix_us)) {
            continue;
        }
        let stamp = fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if best.as_ref().map(|(s, _)| stamp >= *s).unwrap_or(true) {
            best = Some((stamp, path));
        }
    }
    best.map(|(_, p)| p)
}

fn cover_storage_value(abs: &Path) -> String {
    abs.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| abs.to_string_lossy().into_owned())
}

/// Bind `meta.covers` to absolute paths under this machine's `covers/` directory.
/// Used after backup import. Returns true if meta changed.
pub fn remap_covers_to_local(meta: &mut MetaStore) -> Result<bool> {
    ensure_library()?;
    let mut dirty = false;
    let mut next = BTreeMap::new();
    for (skill_id, stored) in meta.covers.iter() {
        let abs = resolve_cover_abs(stored).or_else(|| find_cover_file_for_skill(skill_id));
        match abs {
            Some(path) => {
                let value = path.to_string_lossy().into_owned();
                if value != *stored {
                    dirty = true;
                }
                next.insert(skill_id.clone(), value);
            }
            None => {
                // Drop broken absolute paths from another machine.
                dirty = true;
            }
        }
    }
    // Also discover cover files for skills that have no meta entry yet.
    if let Ok(skills) = skills_dir() {
        if let Ok(entries) = fs::read_dir(skills) {
            for entry in entries.flatten() {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let skill_id = entry.file_name().to_string_lossy().into_owned();
                if skill_id.starts_with('.') || next.contains_key(&skill_id) {
                    continue;
                }
                if let Some(path) = find_cover_file_for_skill(&skill_id) {
                    next.insert(skill_id, path.to_string_lossy().into_owned());
                    dirty = true;
                }
            }
        }
    }
    if dirty || next.len() != meta.covers.len() {
        meta.covers = next;
        dirty = true;
    }
    Ok(dirty)
}

/// Normalize cover entries to filenames before writing a backup meta.json.
pub fn normalize_covers_for_export(meta: &mut MetaStore) -> Result<()> {
    let _ = remap_covers_to_local(meta)?;
    // Force filename-only even when remap reported no change but values were absolute
    // and files still exist on this machine (same path → dirty false above).
    let mut next = BTreeMap::new();
    for (skill_id, stored) in meta.covers.iter() {
        if let Some(abs) = resolve_cover_abs(stored).or_else(|| find_cover_file_for_skill(skill_id)) {
            next.insert(skill_id.clone(), cover_storage_value(&abs));
        } else if !cover_entry_is_path(stored) {
            next.insert(skill_id.clone(), stored.clone());
        }
    }
    meta.covers = next;
    Ok(())
}

struct SkillDocMeta {
    name: String,
    description: String,
    description_zh: String,
}

fn empty_skill_doc() -> SkillDocMeta {
    SkillDocMeta {
        name: String::new(),
        description: String::new(),
        description_zh: String::new(),
    }
}

pub(crate) fn read_skill_description(skill_dir: &Path) -> String {
    read_skill_doc(skill_dir).description
}

/// Frontmatter `name:` for ChatGPT `$name` invoke; empty if missing.
pub fn read_skill_frontmatter_name(skill_id: &str) -> Result<String> {
    let dir = skills_dir()?.join(skill_id);
    Ok(read_skill_doc(&dir).name)
}

fn read_skill_doc(skill_dir: &Path) -> SkillDocMeta {
    let skill_md = skill_dir.join("SKILL.md");
    let alt = skill_dir.join("skill.md");
    let path = if skill_md.exists() {
        skill_md
    } else if alt.exists() {
        alt
    } else {
        return empty_skill_doc();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return empty_skill_doc();
    };
    parse_skill_doc(&content)
}

fn strip_yaml_value(raw: &str) -> String {
    raw.trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string()
}

fn contains_cjk(s: &str) -> bool {
    s.chars().any(|c| {
        ('\u{4e00}'..='\u{9fff}').contains(&c)
            || ('\u{3400}'..='\u{4dbf}').contains(&c)
            || ('\u{f900}'..='\u{faff}').contains(&c)
    })
}

fn parse_skill_doc(content: &str) -> SkillDocMeta {
    let mut in_frontmatter = false;
    let mut name = String::new();
    let mut description = String::new();
    let mut description_zh = String::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            if !in_frontmatter {
                in_frontmatter = true;
                continue;
            }
            break;
        }
        if !in_frontmatter {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("description_zh:") {
            description_zh = strip_yaml_value(rest);
        } else if let Some(rest) = trimmed.strip_prefix("description:") {
            description = strip_yaml_value(rest);
        } else if let Some(rest) = trimmed.strip_prefix("name:") {
            name = strip_yaml_value(rest);
        }
    }

    if description.is_empty() {
        description = content
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && *l != "---" && !l.starts_with('#'))
            .unwrap_or("")
            .chars()
            .take(140)
            .collect();
    }

    // 正文里已是中文简介时，自动当作中文描述
    if description_zh.is_empty() && contains_cjk(&description) {
        description_zh = description.clone();
    }

    SkillDocMeta {
        name,
        description,
        description_zh,
    }
}

const NATIVE_SKILL_BASES: &[&str] = &[
    "skill-creator",
    "skill-installer",
    "openai-docs",
    "imagegen",
    "review-agent",
    "create-rule",
    "create-skill",
    "create-subagent",
    "update-cursor-settings",
    "migrate-to-skills",
    "shell",
];

fn skill_base_id(id: &str) -> &str {
    if let Some((base, num)) = id.rsplit_once('-') {
        if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) {
            return base;
        }
    }
    id
}

fn is_native_skill(id: &str) -> bool {
    let base = skill_base_id(id);
    NATIVE_SKILL_BASES.iter().any(|n| *n == base)
}

pub fn list_skills() -> Result<Vec<SkillCard>> {
    let skills = skills_dir()?;
    let mut meta = load_meta()?;
    let mut meta_dirty = false;
    if repair_covers_from_disk(&mut meta)? {
        meta_dirty = true;
    }
    let mut cards = Vec::new();

    if !skills.exists() {
        return Ok(cards);
    }

    for entry in fs::read_dir(&skills)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let has_skill = path.join("SKILL.md").exists() || path.join("skill.md").exists();
        if !has_skill {
            continue;
        }
        let tags = meta.tags.get(&name).cloned().unwrap_or_default();
        let folder_id = meta.skill_folder.get(&name).cloned();
        let cover_path = {
            let stored = meta.covers.get(&name).cloned();
            // Resolve filename-or-absolute; also recover from covers/ when meta is missing.
            match stored
                .as_deref()
                .and_then(resolve_cover_abs)
                .or_else(|| find_cover_file_for_skill(&name))
            {
                Some(abs) => {
                    let abs_str = abs.to_string_lossy().into_owned();
                    // Keep local meta on absolute paths so asset protocol / older builds keep working.
                    if stored.as_deref() != Some(abs_str.as_str()) {
                        meta.covers.insert(name.clone(), abs_str.clone());
                        meta_dirty = true;
                    }
                    Some(abs_str)
                }
                None => None,
            }
        };
        let display_name = meta
            .display_names
            .get(&name)
            .cloned()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| name.clone());
        let doc = read_skill_doc(&path);
        let description_zh = meta
            .description_zh
            .get(&name)
            .cloned()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(doc.description_zh);
        let imported_at = meta
            .imported_at
            .get(&name)
            .copied()
            .or_else(|| dir_birth_secs(&path));
        if let Some(ts) = imported_at {
            if !meta.imported_at.contains_key(&name) {
                meta.imported_at.insert(name.clone(), ts);
                meta_dirty = true;
            }
        }
        cards.push(SkillCard {
            id: name.clone(),
            name: name.clone(),
            display_name,
            description: doc.description,
            description_zh,
            path: path.to_string_lossy().into_owned(),
            tags,
            pinned: meta.pinned.contains(&name),
            invoke: format!("${name}"),
            folder_id,
            cover_path,
            is_native: is_native_skill(&name),
            local_modified: meta.locally_edited.contains(&name),
            imported_at,
        });
    }

    if meta_dirty {
        let _ = save_meta(&meta);
    }

    cards.sort_by(|a, b| match (b.pinned, a.pinned) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()),
    });
    Ok(cards)
}

pub fn set_skill_display_name(skill_id: &str, name: String) -> Result<Vec<SkillCard>> {
    let mut meta = load_meta()?;
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() || trimmed == skill_id {
        meta.display_names.remove(skill_id);
    } else {
        meta.display_names.insert(skill_id.to_string(), trimmed);
    }
    save_meta(&meta)?;
    list_skills()
}

fn skill_markdown_path(skill_id: &str) -> Result<PathBuf> {
    let path = skills_dir()?.join(skill_id);
    if !path.is_dir() {
        anyhow::bail!("技能不存在：{skill_id}");
    }
    let skill_md = path.join("SKILL.md");
    let alt = path.join("skill.md");
    if skill_md.exists() {
        Ok(skill_md)
    } else if alt.exists() {
        Ok(alt)
    } else {
        Ok(skill_md)
    }
}

pub fn read_skill_markdown(skill_id: &str) -> Result<String> {
    let file = skill_markdown_path(skill_id)?;
    if !file.exists() {
        anyhow::bail!("未找到 SKILL.md");
    }
    fs::read_to_string(&file).with_context(|| format!("读取失败: {}", file.display()))
}

pub fn write_skill_markdown(skill_id: &str, content: &str) -> Result<PathBuf> {
    let dir = skills_dir()?.join(skill_id);
    if !dir.is_dir() {
        anyhow::bail!("技能不存在：{skill_id}");
    }
    let file = skill_markdown_path(skill_id)?;
    fs::write(&file, content).with_context(|| format!("写入失败: {}", file.display()))?;
    // Mark as locally edited; keep content_hashes as last source-sync baseline.
    let mut meta = load_meta()?;
    meta.locally_edited.insert(skill_id.to_string());
    save_meta(&meta)?;
    Ok(dir)
}

pub fn backups_dir() -> Result<PathBuf> {
    Ok(root_dir()?.join("backups"))
}

pub fn set_skill_tags(skill_id: &str, tags: Vec<String>) -> Result<Vec<SkillCard>> {
    let mut meta = load_meta()?;
    let cleaned: Vec<String> = tags
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if cleaned.is_empty() {
        meta.tags.remove(skill_id);
    } else {
        meta.tags.insert(skill_id.to_string(), cleaned);
    }
    save_meta(&meta)?;
    list_skills()
}

pub fn toggle_pin(skill_id: &str) -> Result<Vec<SkillCard>> {
    let mut meta = load_meta()?;
    if meta.pinned.contains(skill_id) {
        meta.pinned.remove(skill_id);
    } else {
        meta.pinned.insert(skill_id.to_string());
    }
    save_meta(&meta)?;
    list_skills()
}

pub fn all_tags() -> Result<Vec<String>> {
    let meta = load_meta()?;
    let mut set = BTreeSet::new();
    for tags in meta.tags.values() {
        for tag in tags {
            set.insert(tag.clone());
        }
    }
    Ok(set.into_iter().collect())
}

pub fn list_folders() -> Result<Vec<Folder>> {
    Ok(load_meta()?.folders)
}

pub fn create_folder(name: &str) -> Result<Vec<Folder>> {
    let name = name.trim();
    if name.is_empty() {
        anyhow::bail!("文件夹名称不能为空");
    }
    let mut meta = load_meta()?;
    if meta.folders.iter().any(|f| f.name == name) {
        anyhow::bail!("已存在同名文件夹");
    }
    let id = format!(
        "f{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    meta.folders.push(Folder {
        id,
        name: name.to_string(),
    });
    save_meta(&meta)?;
    Ok(meta.folders)
}

pub fn rename_folder(folder_id: &str, name: &str) -> Result<Vec<Folder>> {
    let name = name.trim();
    if name.is_empty() {
        anyhow::bail!("文件夹名称不能为空");
    }
    let mut meta = load_meta()?;
    let Some(folder) = meta.folders.iter_mut().find(|f| f.id == folder_id) else {
        anyhow::bail!("文件夹不存在");
    };
    folder.name = name.to_string();
    save_meta(&meta)?;
    Ok(meta.folders)
}

pub fn delete_folder(folder_id: &str) -> Result<Vec<Folder>> {
    let mut meta = load_meta()?;
    meta.folders.retain(|f| f.id != folder_id);
    meta.skill_folder.retain(|_, fid| fid != folder_id);
    save_meta(&meta)?;
    Ok(meta.folders)
}

pub fn set_skill_folder(skill_id: &str, folder_id: Option<String>) -> Result<Vec<SkillCard>> {
    let mut meta = load_meta()?;
    match folder_id {
        Some(fid) if !fid.is_empty() => {
            if !meta.folders.iter().any(|f| f.id == fid) {
                anyhow::bail!("文件夹不存在");
            }
            meta.skill_folder.insert(skill_id.to_string(), fid);
        }
        _ => {
            meta.skill_folder.remove(skill_id);
        }
    }
    save_meta(&meta)?;
    list_skills()
}

pub fn set_skill_description_zh(skill_id: &str, text: String) -> Result<Vec<SkillCard>> {
    let mut meta = load_meta()?;
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        meta.description_zh.remove(skill_id);
    } else {
        meta.description_zh.insert(skill_id.to_string(), trimmed);
    }
    save_meta(&meta)?;
    list_skills()
}

fn remove_cover_files_for(skill_id: &str, keep: Option<&Path>) {
    let Ok(dir) = covers_dir() else { return };
    let Ok(entries) = fs::read_dir(dir) else { return };
    let prefix_dot = format!("{skill_id}.");
    let prefix_us = format!("{skill_id}_");
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if keep.is_some_and(|k| k == path.as_path()) {
            continue;
        }
        if name.starts_with(&prefix_dot) || name.starts_with(&prefix_us) {
            let _ = fs::remove_file(path);
        }
    }
}

/// Card covers: downscale + JPEG so AI/4K sources stay lightweight on disk & in backups.
const COVER_MAX_EDGE: u32 = 960;
const COVER_MIN_EDGE: u32 = 640;
const COVER_JPEG_QUALITY_START: u8 = 78;
const COVER_JPEG_QUALITY_MIN: u8 = 55;
/// Soft budget; encoder will lower quality / edge until under this (or floors hit).
const COVER_TARGET_BYTES: usize = 160 * 1024;

fn encode_cover_jpeg(rgb: &image::RgbImage, quality: u8) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
    encoder
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .context("压缩封面失败")?;
    Ok(out)
}

fn compress_cover_to_jpeg(source: &Path, dest: &Path) -> Result<()> {
    let img = image::open(source).with_context(|| format!("读取封面失败: {}", source.display()))?;
    let mut edge = COVER_MAX_EDGE.min(img.width().max(img.height()).max(1));
    let mut quality = COVER_JPEG_QUALITY_START;
    let mut best = encode_cover_jpeg(
        &{
            let resized = if img.width().max(img.height()) > edge {
                img.resize(edge, edge, image::imageops::FilterType::Triangle)
            } else {
                img.clone()
            };
            resized.to_rgb8()
        },
        quality,
    )?;

    // Progressively tighten until under budget or floors are hit.
    while best.len() > COVER_TARGET_BYTES {
        if quality > COVER_JPEG_QUALITY_MIN {
            quality = quality.saturating_sub(8).max(COVER_JPEG_QUALITY_MIN);
        } else if edge > COVER_MIN_EDGE {
            edge = ((edge * 3) / 4).max(COVER_MIN_EDGE);
            quality = COVER_JPEG_QUALITY_START;
        } else {
            break;
        }
        let resized = if img.width().max(img.height()) > edge {
            img.resize(edge, edge, image::imageops::FilterType::Triangle)
        } else {
            img.clone()
        };
        let candidate = encode_cover_jpeg(&resized.to_rgb8(), quality)?;
        if candidate.len() < best.len() {
            best = candidate;
        } else if quality <= COVER_JPEG_QUALITY_MIN && edge <= COVER_MIN_EDGE {
            break;
        }
    }

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(dest, best).with_context(|| format!("写入封面失败: {}", dest.display()))?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverCompressResult {
    pub scanned: u32,
    pub compressed: u32,
    pub skipped: u32,
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub message: String,
}

fn format_bytes(n: u64) -> String {
    if n >= 1024 * 1024 {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    } else if n >= 1024 {
        format!("{:.0} KB", n as f64 / 1024.0)
    } else {
        format!("{n} B")
    }
}

/// Re-encode every cover under `covers/` to the current JPEG budget and refresh meta paths.
pub fn recompress_all_covers() -> Result<(CoverCompressResult, Vec<SkillCard>)> {
    ensure_library()?;
    let dir = covers_dir()?;
    let mut scanned = 0u32;
    let mut compressed = 0u32;
    let mut skipped = 0u32;
    let mut bytes_before = 0u64;
    let mut bytes_after = 0u64;
    let mut renamed: BTreeMap<String, String> = BTreeMap::new();

    let entries: Vec<_> = fs::read_dir(&dir)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();

    for path in entries {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp") {
            continue;
        }

        scanned += 1;
        let before = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        bytes_before += before;

        // Already small enough JPEG — keep as-is.
        if matches!(ext.as_str(), "jpg" | "jpeg") && before > 0 && before as usize <= COVER_TARGET_BYTES {
            bytes_after += before;
            skipped += 1;
            continue;
        }

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "cover".into());
        // Preserve skill_id prefix (`id_stamp` or `id`) for later lookup.
        let skill_prefix = stem
            .split_once('_')
            .map(|(id, _)| id.to_string())
            .unwrap_or_else(|| stem.clone());
        let tmp = dir.join(format!(".{skill_prefix}_recompress-{stamp}.jpg"));
        let final_path = dir.join(format!("{skill_prefix}_{stamp}.jpg"));

        match compress_cover_to_jpeg(&path, &tmp) {
            Ok(()) => {
                let after = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
                // Only keep if we actually shrink (or convert non-jpeg).
                if after > 0 && (after < before || !matches!(ext.as_str(), "jpg" | "jpeg")) {
                    if let Err(err) = fs::rename(&tmp, &final_path) {
                        let _ = fs::remove_file(&tmp);
                        bytes_after += before;
                        skipped += 1;
                        eprintln!("封面压缩替换失败 {}: {err}", path.display());
                        continue;
                    }
                    let _ = fs::remove_file(&path);
                    bytes_after += after;
                    compressed += 1;
                    renamed.insert(name, final_path.to_string_lossy().into_owned());
                } else {
                    let _ = fs::remove_file(&tmp);
                    bytes_after += before;
                    skipped += 1;
                }
            }
            Err(err) => {
                let _ = fs::remove_file(&tmp);
                bytes_after += before;
                skipped += 1;
                eprintln!("封面压缩跳过 {}: {err:#}", path.display());
            }
        }
    }

    // Point meta.covers at recompressed absolute paths when we renamed files.
    if !renamed.is_empty() {
        let mut meta = load_meta()?;
        let mut dirty = false;
        for (skill_id, stored) in meta.covers.clone() {
            let key = cover_basename(&stored).unwrap_or(stored.clone());
            if let Some(new_abs) = renamed.get(&key) {
                meta.covers.insert(skill_id, new_abs.clone());
                dirty = true;
            }
        }
        // Also bind any skill whose cover file was recompressed by prefix scan.
        for (old_name, new_abs) in &renamed {
            let skill_id = old_name
                .split_once('_')
                .map(|(id, _)| id)
                .or_else(|| old_name.split_once('.').map(|(id, _)| id))
                .unwrap_or(old_name.as_str());
            if !meta.covers.contains_key(skill_id) {
                continue;
            }
            let cur = meta.covers.get(skill_id).cloned().unwrap_or_default();
            let cur_base = cover_basename(&cur).unwrap_or(cur);
            if cur_base == *old_name || resolve_cover_abs(&cur_base).is_none() {
                meta.covers.insert(skill_id.to_string(), new_abs.clone());
                dirty = true;
            }
        }
        if dirty {
            save_meta(&meta)?;
        }
    }

    let saved = bytes_before.saturating_sub(bytes_after);
    let message = if compressed == 0 {
        format!(
            "扫描 {scanned} 张封面，无需再压（已跳过 {skipped}）"
        )
    } else {
        format!(
            "已压缩 {compressed}/{scanned} 张封面，约节省 {}（前 {} → 后 {}）",
            format_bytes(saved),
            format_bytes(bytes_before),
            format_bytes(bytes_after)
        )
    };

    Ok((
        CoverCompressResult {
            scanned,
            compressed,
            skipped,
            bytes_before,
            bytes_after,
            message,
        },
        list_skills()?,
    ))
}

pub fn set_skill_cover(skill_id: &str, source_path: &str) -> Result<Vec<SkillCard>> {
    ensure_library()?;
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        anyhow::bail!("封面文件不存在");
    }
    let ext = source
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "png".into());
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp") {
        anyhow::bail!("仅支持 png/jpg/webp/gif 图片");
    }
    // Unique filename so asset protocol / browser cache never sticks to an old image.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = covers_dir()?.join(format!("{skill_id}_{stamp}.jpg"));
    if let Err(err) = compress_cover_to_jpeg(&source, &dest) {
        // Fallback: keep original bytes if decode/compress fails
        let fallback = covers_dir()?.join(format!("{skill_id}_{stamp}.{ext}"));
        fs::copy(&source, &fallback)
            .with_context(|| format!("复制封面失败（压缩也失败: {err}）: {}", fallback.display()))?;
        remove_cover_files_for(skill_id, Some(&fallback));
        let mut meta = load_meta()?;
        meta.covers
            .insert(skill_id.to_string(), fallback.to_string_lossy().into_owned());
        save_meta(&meta)?;
        return list_skills();
    }

    remove_cover_files_for(skill_id, Some(&dest));

    let mut meta = load_meta()?;
    meta.covers
        .insert(skill_id.to_string(), dest.to_string_lossy().into_owned());
    save_meta(&meta)?;
    list_skills()
}

pub fn delete_skill(skill_id: &str) -> Result<Vec<SkillCard>> {
    let skills = skills_dir()?;
    let path = skills.join(skill_id);
    if !path.is_dir() {
        anyhow::bail!("技能不存在：{skill_id}");
    }
    fs::remove_dir_all(&path).with_context(|| format!("删除失败: {}", path.display()))?;

    let mut meta = load_meta()?;
    meta.tags.remove(skill_id);
    meta.pinned.remove(skill_id);
    meta.skill_folder.remove(skill_id);
    meta.description_zh.remove(skill_id);
    meta.display_names.remove(skill_id);
    meta.sources.remove(skill_id);
    meta.content_hashes.remove(skill_id);
    meta.locally_edited.remove(skill_id);
    meta.imported_at.remove(skill_id);
    if let Some(stored) = meta.covers.remove(skill_id) {
        if let Some(abs) = resolve_cover_abs(&stored) {
            let _ = fs::remove_file(abs);
        }
    }
    remove_cover_files_for(skill_id, None);
    save_meta(&meta)?;
    list_skills()
}

pub fn clear_skill_cover(skill_id: &str) -> Result<Vec<SkillCard>> {
    let mut meta = load_meta()?;
    if let Some(stored) = meta.covers.remove(skill_id) {
        if let Some(abs) = resolve_cover_abs(&stored) {
            let _ = fs::remove_file(abs);
        }
    }
    remove_cover_files_for(skill_id, None);
    save_meta(&meta)?;
    list_skills()
}

pub fn default_cursor_skills_dir() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        return home.join(".cursor").join("skills");
    }
    PathBuf::from(".cursor/skills")
}

pub fn default_codex_skills_dir() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        return home.join(".codex").join("skills");
    }
    PathBuf::from(".codex/skills")
}

pub fn resolve_agent_dir(agent: &str) -> Result<PathBuf> {
    let meta = load_meta()?;
    match agent {
        "cursor" => Ok(meta
            .cursor_skills_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(default_cursor_skills_dir)),
        "codex" => Ok(meta
            .codex_skills_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(default_codex_skills_dir)),
        _ => anyhow::bail!("Unsupported agent for deploy: {agent}"),
    }
}

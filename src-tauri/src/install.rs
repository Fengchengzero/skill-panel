use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use crate::library;

const GIT_CLONE_TIMEOUT_SECS: u64 = 180;
const GITHUB_ZIP_TIMEOUT_SECS: u64 = 120;

static INSTALL_CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallProgress {
    pub stage: String,
    pub percent: u8,
    pub message: String,
}

fn emit_progress(app: Option<&AppHandle>, stage: &str, percent: u8, message: &str) {
    let Some(app) = app else { return };
    let _ = app.emit(
        "install-progress",
        InstallProgress {
            stage: stage.to_string(),
            percent: percent.min(100),
            message: message.to_string(),
        },
    );
}

pub fn request_cancel_install() {
    INSTALL_CANCELLED.store(true, Ordering::SeqCst);
}

fn begin_install_session() {
    INSTALL_CANCELLED.store(false, Ordering::SeqCst);
}

fn is_install_cancelled() -> bool {
    INSTALL_CANCELLED.load(Ordering::SeqCst)
}

fn ensure_not_cancelled() -> Result<()> {
    if is_install_cancelled() {
        anyhow::bail!("已取消安装");
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkippedDuplicate {
    pub name: String,
    pub similar_to: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InstallResult {
    pub installed: Vec<String>,
    pub skipped: Vec<SkippedDuplicate>,
    #[serde(default)]
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NestedSkillInfo {
    /// Path relative to the package root, e.g. `skills/productivity/grill-me`.
    pub rel_path: String,
    /// Folder name used as skill id when extracted, e.g. `grill-me`.
    pub id: String,
    pub name: String,
    pub description: String,
    pub already_installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpdateStatus {
    Outdated,
    MissingSource,
    SourceGone,
    UpToDate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillUpdateInfo {
    pub skill_id: String,
    pub name: String,
    pub source_path: Option<String>,
    pub status: UpdateStatus,
    #[serde(default)]
    pub local_modified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateApplyResult {
    pub updated: Vec<String>,
    pub errors: Vec<String>,
}

/// Only skip exact same folder name. Fuzzy “-2” stripping was blocking real imports.
fn find_existing_same_name(preferred: &str) -> Result<Option<String>> {
    let want = sanitize_folder_name(preferred).to_lowercase();
    let skills = library::skills_dir()?;
    if !skills.exists() {
        return Ok(None);
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
        let has_skill = entry.path().join("SKILL.md").exists() || entry.path().join("skill.md").exists();
        if !has_skill {
            continue;
        }
        if name.to_lowercase() == want {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

fn should_skip_copy_name(name: &str) -> bool {
    should_skip_scan_dir(name)
        || matches!(
            name,
            ".github"
                | ".changeset"
                | ".claude-plugin"
                | ".agents"
                | ".out-of-scope"
                | ".DS_Store"
                | "package-lock.json"
                | "yarn.lock"
                | "pnpm-lock.yaml"
        )
}

fn copy_skill_dir(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if should_skip_copy_name(&name_str) {
            continue;
        }
        if ft.is_symlink() {
            continue;
        }
        let target = dst.join(&name);
        if ft.is_dir() {
            copy_skill_dir(&entry.path(), &target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn should_skip_scan_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".svn"
            | ".hg"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".skill-panel"
            | ".system"
            | ".idea"
            | ".vs"
            | ".github"
            | ".changeset"
            | ".claude-plugin"
            | ".agents"
            | ".out-of-scope"
    )
}

fn has_skill_md(dir: &Path) -> bool {
    // exists() follows Windows junctions/symlinks, unlike WalkDir's default.
    dir.join("SKILL.md").exists() || dir.join("skill.md").exists()
}

/// Recursively find skill roots. Uses read_dir + exists so Codex/Cursor
/// junction-linked skill folders are visible (WalkDir skips them by default).
fn scan_skill_dirs(path: &Path, depth: usize, max_depth: usize, found: &mut Vec<PathBuf>) {
    if should_skip_scan_dir(
        &path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
    ) && depth > 0
    {
        return;
    }

    if has_skill_md(path) {
        found.push(path.to_path_buf());
        return;
    }

    if depth >= max_depth {
        return;
    }

    let Ok(entries) = fs::read_dir(path) else {
        return;
    };

    for entry in entries.flatten() {
        let child = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && should_skip_scan_dir(&name) {
            continue;
        }
        // Junctions/symlinks: file_type may say symlink; is_dir() still true after resolve.
        if child.is_dir() {
            scan_skill_dirs(&child, depth + 1, max_depth, found);
        } else if name.eq_ignore_ascii_case("skill.md") {
            if let Some(parent) = child.parent() {
                found.push(parent.to_path_buf());
            }
        }
    }
}

/// Flat skill libraries only (e.g. `~/.cursor/skills` with one skill per child folder).
fn is_skills_collection_dir(path: &Path) -> bool {
    let raw = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    // Do NOT strip `-main` here: GitHub zip roots like `skills-main` are packages,
    // not the user's local skills library.
    matches!(
        raw.as_str(),
        "skills"
            | "skill"
            | "agent-skills"
            | "agents-skills"
            | ".agents"
            | ".cursor"
            | ".codex"
            | ".claude"
            | ".skill-panel"
    )
}

/// Batch-split only for a flat skills library. Deep trees (e.g. mattpocock/skills
/// with `skills/category/name/SKILL.md`) stay as ONE package.
fn coalesce_bundle_roots(selected: &Path, found: Vec<PathBuf>) -> Vec<PathBuf> {
    if found.len() <= 1 {
        return found;
    }

    let all_direct = found.iter().all(|p| p.parent() == Some(selected));
    if all_direct && is_skills_collection_dir(selected) {
        // ~/.cursor/skills/{a,b,c} → import each skill separately
        return found;
    }

    // Everything else (GitHub repos, categorized packs, wrappers) → one card
    vec![selected.to_path_buf()]
}

fn is_auto_bundle_stub(content: &str) -> bool {
    let lower = content.to_lowercase();
    (lower.contains("skill package with") && lower.contains("nested sub-skill"))
        || content.contains("This package contains nested sub-skills")
        || content.contains("<!-- skill-panel:auto-bundle -->")
}

fn readme_excerpt(root: &Path) -> Option<String> {
    const NAMES: &[&str] = &["README.md", "README", "readme.md", "Readme.md"];
    for name in NAMES {
        let path = root.join(name);
        if !path.is_file() {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let excerpt = summarize_readme(&text);
        if !excerpt.is_empty() {
            return Some(excerpt);
        }
    }
    None
}

fn looks_like_markup_noise(trimmed: &str) -> bool {
    let lower = trimmed.to_ascii_lowercase();
    trimmed.starts_with("![")
        || trimmed.starts_with("[![")
        || lower.starts_with("<img")
        || lower.starts_with("<picture")
        || lower.starts_with("<source")
        || lower.starts_with("<p>")
        || lower.starts_with("</")
        || lower.starts_with("<div")
        || lower.starts_with("<a ")
        || lower.starts_with("<a>")
        || lower == "<p>"
        || lower == "</p>"
        || (trimmed.starts_with('<') && trimmed.ends_with('>'))
}

fn summarize_readme(text: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    let mut skipping_code = false;
    for raw in text.lines() {
        let line = raw.trim_end();
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            skipping_code = !skipping_code;
            continue;
        }
        if skipping_code {
            continue;
        }
        if trimmed.is_empty() {
            if !lines.is_empty() && lines.last() != Some(&"") {
                lines.push("");
            }
            continue;
        }
        if looks_like_markup_noise(trimmed) {
            continue;
        }
        if trimmed.starts_with('#') {
            // Keep first heading text without hashes as a short lead if body is empty so far.
            if lines.is_empty() {
                let title = trimmed.trim_start_matches('#').trim();
                if !title.is_empty() {
                    lines.push(title);
                    lines.push("");
                }
            }
            continue;
        }
        lines.push(trimmed);
        let so_far: usize = lines.iter().map(|l| l.len() + 1).sum();
        if so_far >= 700 {
            break;
        }
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    let mut out = lines.join("\n");
    if out.len() > 900 {
        out.truncate(900);
        if let Some(idx) = out.rfind([' ', '\n']) {
            out.truncate(idx);
        }
        out.push_str("…");
    }
    out
}

fn bundle_description(name: &str, nested_count: usize, readme: Option<&str>) -> String {
    if let Some(r) = readme {
        let first = r
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or(name);
        let mut desc = format!("{first} ({nested_count} nested skills)");
        if desc.len() > 180 {
            desc.truncate(177);
            desc.push_str("...");
        }
        desc
    } else {
        format!("Skill package «{name}» with {nested_count} nested sub-skill(s). Expand-deploy or install nested skills from Skill Panel.")
    }
}

/// Ensure a bundle root is listable/deployable. Regenerates weak auto-stubs from README.
fn ensure_bundle_skill_md(skill_root: &Path) -> Result<()> {
    if has_skill_md(skill_root) {
        let existing = fs::read_to_string(skill_root.join("SKILL.md"))
            .or_else(|_| fs::read_to_string(skill_root.join("skill.md")))
            .unwrap_or_default();
        if !is_auto_bundle_stub(&existing) {
            return Ok(());
        }
    }

    let name = skill_root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".into());

    let nested = collect_nested_skill_dirs(skill_root);
    let entries: Vec<(String, String)> = nested
        .iter()
        .filter_map(|p| {
            let id = p.file_name()?.to_string_lossy().to_string();
            let rel = p
                .strip_prefix(skill_root)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            Some((id, rel))
        })
        .collect();

    let readme = readme_excerpt(skill_root);
    let desc = bundle_description(&name, entries.len().max(1), readme.as_deref());
    let about = readme.unwrap_or_else(|| {
        "This repository/package groups multiple Agent Skills under one folder.".into()
    });

    let list = if entries.is_empty() {
        "- (nested skills)".to_string()
    } else {
        entries
            .iter()
            .take(80)
            .map(|(id, rel)| format!("- `${id}` — `{rel}`"))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let desc_yaml = desc.replace('\\', "\\\\").replace('"', "\\\"");
    let body = format!(
        "---\nname: {name}\ndescription: \"{desc_yaml}\"\n---\n\n<!-- skill-panel:auto-bundle -->\n\n# {name}\n\n## About\n\n{about}\n\n## Contained skills ({count})\n\n{list}\n\n## How to use\n\n1. **Skill Panel** → open this card → select nested skills → **安装到库** (install as separate cards), or **展开部署到 Agent**.\n2. After expand-deploy, invoke individual skills in Cursor/Codex, e.g. `$grill-me`.\n3. Keeping this package card is optional; nested skills are what Agent loads at the top level.\n",
        count = entries.len().max(1),
    );

    fs::write(skill_root.join("SKILL.md"), body)
        .with_context(|| format!("无法为组合技能写入 SKILL.md：{}", skill_root.display()))?;
    Ok(())
}

fn package_name_from_git_url(url: &str) -> String {
    if let Some((owner, repo)) = parse_github_repo(url) {
        return sanitize_folder_name(&format!("{owner}-{repo}"));
    }
    let trimmed = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let base = trimmed
        .rsplit('/')
        .next()
        .unwrap_or("git-skill")
        .trim();
    sanitize_folder_name(if base.is_empty() { "git-skill" } else { base })
}

/// Resolve one path into one or many skill roots.
/// Selecting a parent skills folder (no SKILL.md at root) scans nested skills —
/// users do not need to open each skill folder one by one.
/// A non-library package that contains multiple sub-skills stays as one root.
fn find_skill_dirs(path: &Path) -> Result<Vec<PathBuf>> {
    if path.is_file() {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if name == "skill.md" {
            if let Some(parent) = path.parent() {
                return Ok(vec![parent.to_path_buf()]);
            }
        }
        anyhow::bail!("请选择技能文件夹、.zip / .skill 压缩包，或 SKILL.md");
    }

    // Exact skill root: import this folder only (nested SKILL.md stay inside).
    if has_skill_md(path) {
        return Ok(vec![path.to_path_buf()]);
    }

    let mut found = Vec::new();
    scan_skill_dirs(path, 0, 8, &mut found);
    found.sort();
    found.dedup();
    if found.is_empty() {
        anyhow::bail!(
            "该目录下没有扫描到 Skill。请直接选技能库的上级文件夹（会自动批量导入），不必点进每个技能。"
        );
    }
    Ok(coalesce_bundle_roots(path, found))
}

fn unique_dest(skills: &Path, preferred: &str) -> PathBuf {
    let safe = sanitize_folder_name(preferred);
    let base = skills.join(&safe);
    if !base.exists() {
        return base;
    }
    for i in 2u32.. {
        let candidate = skills.join(format!("{safe}-{i}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    base
}

fn sanitize_folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "skill".into()
    } else {
        trimmed.to_string()
    }
}

enum InstallOne {
    Installed(String),
    Skipped(SkippedDuplicate),
}

fn is_ephemeral_path(path: &Path) -> bool {
    let Ok(canon) = path.canonicalize() else {
        return false;
    };
    if let Ok(tmp) = std::env::temp_dir().canonicalize() {
        if canon.starts_with(&tmp) {
            return true;
        }
    }
    false
}

fn fnv1a_hex(data: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in data {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Fingerprint a skill directory. SKILL.md uses content hash; other files use size+mtime.
pub fn skill_fingerprint(dir: &Path) -> Result<String> {
    let mut parts: Vec<String> = Vec::new();
    collect_fingerprint(dir, dir, &mut parts)?;
    parts.sort();
    Ok(fnv1a_hex(parts.join("\n").as_bytes()))
}

fn collect_fingerprint(root: &Path, current: &Path, parts: &mut Vec<String>) -> Result<()> {
    let Ok(entries) = fs::read_dir(current) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_scan_dir(&name) || name == ".DS_Store" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_fingerprint(root, &path, parts)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = meta.len();
        if name.eq_ignore_ascii_case("skill.md") {
            let content = fs::read(&path).unwrap_or_default();
            parts.push(format!("{rel}|{size}|c:{}", fnv1a_hex(&content)));
        } else {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            parts.push(format!("{rel}|{size}|m:{mtime}"));
        }
    }
    Ok(())
}

fn record_origin(skill_id: &str, source_root: &Path) -> Result<()> {
    if is_ephemeral_path(source_root) {
        return Ok(());
    }
    let source = source_root
        .canonicalize()
        .unwrap_or_else(|_| source_root.to_path_buf());
    let local = library::skills_dir()?.join(skill_id);
    let fp = if local.exists() {
        skill_fingerprint(&local)?
    } else {
        skill_fingerprint(source_root)?
    };
    let mut meta = library::load_meta()?;
    meta.sources
        .insert(skill_id.to_string(), source.to_string_lossy().into_owned());
    meta.content_hashes.insert(skill_id.to_string(), fp);
    library::touch_imported_at(&mut meta, skill_id);
    library::save_meta(&meta)?;
    Ok(())
}

fn install_skill_dir(skill_root: &Path, name: Option<&str>) -> Result<InstallOne> {
    let folder_name = name
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            skill_root
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "skill".into())
        });

    if let Some(existing) = find_existing_same_name(&folder_name)? {
        return Ok(InstallOne::Skipped(SkippedDuplicate {
            name: folder_name,
            similar_to: existing.clone(),
            reason: format!("已存在同名技能「{existing}」，已跳过"),
        }));
    }

    let skills = library::skills_dir()?;
    let dest = unique_dest(&skills, &folder_name);
    let final_name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or(folder_name);
    if dest.exists() {
        fs::remove_dir_all(&dest)?;
    }
    copy_skill_dir(skill_root, &dest)?;
    // Bundle packages may only have SKILL.md in subfolders — write a root stub so
    // the library lists one card and deploy keeps nested sub-skills inside.
    ensure_bundle_skill_md(&dest)?;
    let _ = record_origin(&final_name, skill_root);
    // Ensure import time even when origin is ephemeral (zip/temp) and record_origin skips.
    if let Ok(mut meta) = library::load_meta() {
        library::touch_imported_at(&mut meta, &final_name);
        let _ = library::save_meta(&meta);
    }
    Ok(InstallOne::Installed(final_name))
}

fn push_install_result(result: &mut InstallResult, root: &Path, name: Option<&str>) {
    match install_skill_dir(root, name) {
        Ok(one) => push_outcome(result, one),
        Err(e) => result.errors.push(format!("{}: {e}", root.display())),
    }
}

fn push_outcome(result: &mut InstallResult, one: InstallOne) {
    match one {
        InstallOne::Installed(name) => result.installed.push(name),
        InstallOne::Skipped(skip) => result.skipped.push(skip),
    }
}

fn safe_extract_zip(archive_path: &Path, dest: &Path) -> Result<()> {
    let file = fs::File::open(archive_path)
        .with_context(|| format!("无法打开压缩包 {:?}", archive_path))?;
    let mut archive = zip::ZipArchive::new(file).context("无法读取 zip/.skill 压缩包")?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let out_path = dest.join(enclosed);
        if !out_path.starts_with(dest) {
            continue;
        }
        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut outfile = fs::File::create(&out_path)?;
            std::io::copy(&mut entry, &mut outfile)?;
        }
    }
    Ok(())
}

fn install_from_archive(archive_path: &Path) -> Result<InstallResult> {
    let tmp = tempfile_dir()?.join("extract");
    fs::create_dir_all(&tmp)?;
    safe_extract_zip(archive_path, &tmp)?;
    // Prefer the single top-level folder GitHub/npm-style zips wrap content in.
    let scan_root = unwrap_archive_root(&tmp);
    let roots = find_skill_dirs(&scan_root)?;
    let mut result = InstallResult::default();
    for root in roots {
        push_install_result(&mut result, &root, None);
    }
    let _ = fs::remove_dir_all(tmp.parent().unwrap_or(&tmp));
    Ok(result)
}

/// Import a local folder, SKILL.md, or .zip/.skill archive.
pub fn install_from_local(source: &str, name: Option<String>) -> Result<InstallResult> {
    library::ensure_library()?;
    let source_path = PathBuf::from(source.trim().trim_matches('"'));
    if !source_path.exists() {
        anyhow::bail!("路径不存在：{}", source_path.display());
    }

    if source_path.is_file() {
        let ext = source_path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if ext == "zip" || ext == "skill" {
            return install_from_archive(&source_path);
        }
        let file_name = source_path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if file_name == "skill.md" {
            let parent = source_path
                .parent()
                .context("SKILL.md 没有父目录")?;
            let mut result = InstallResult::default();
            push_install_result(&mut result, parent, name.as_deref());
            return Ok(result);
        }
        anyhow::bail!("不支持的文件类型。请选择文件夹、SKILL.md，或 .zip / .skill");
    }

    let roots = find_skill_dirs(&source_path)?;
    let mut result = InstallResult::default();
    if roots.len() == 1 {
        push_install_result(&mut result, &roots[0], name.as_deref());
    } else {
        for root in roots {
            push_install_result(&mut result, &root, None);
        }
    }
    if result.installed.is_empty()
        && result.skipped.is_empty()
        && !result.errors.is_empty()
    {
        anyhow::bail!("{}", result.errors.join("；"));
    }
    Ok(result)
}

fn normalize_git_url(repo_url: &str) -> String {
    let trimmed = repo_url.trim();
    if trimmed.contains("://") || trimmed.starts_with("git@") {
        return trimmed.to_string();
    }
    format!("https://github.com/{}.git", trimmed.trim_end_matches(".git"))
}

fn parse_git_progress_line(line: &str) -> Option<(u8, String)> {
    let lower = line.to_lowercase();
    let pct = line
        .find('%')
        .and_then(|idx| {
            let start = line[..idx]
                .rfind(|c: char| !c.is_ascii_digit())
                .map(|i| i + 1)
                .unwrap_or(0);
            line[start..idx].parse::<u8>().ok()
        })
        .unwrap_or(0);

    if lower.contains("receiving objects") {
        Some(((pct as u16 * 70 / 100) as u8 + 10, line.trim().to_string()))
    } else if lower.contains("resolving deltas") {
        Some(((pct as u16 * 15 / 100) as u8 + 80, line.trim().to_string()))
    } else if lower.contains("remote:") || lower.contains("counting objects") {
        Some((8, line.trim().to_string()))
    } else if lower.contains("cloning into") {
        Some((5, "开始克隆仓库…".into()))
    } else if !line.trim().is_empty() {
        Some((12, line.trim().to_string()))
    } else {
        None
    }
}

/// Parse `owner/repo` from a GitHub URL or shorthand slug.
fn parse_github_repo(input: &str) -> Option<(String, String)> {
    let trimmed = input.trim().trim_end_matches('/').trim_end_matches(".git");
    let path = if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        rest.to_string()
    } else if let Some(rest) = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))
        .or_else(|| trimmed.strip_prefix("https://www.github.com/"))
        .or_else(|| trimmed.strip_prefix("http://www.github.com/"))
    {
        rest.split('/').take(2).collect::<Vec<_>>().join("/")
    } else if trimmed.contains("://") || trimmed.starts_with("git@") {
        return None;
    } else {
        trimmed.to_string()
    };

    let mut parts = path.split('/').filter(|p| !p.is_empty());
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    if owner.is_empty() || repo.is_empty() || repo.contains(':') {
        return None;
    }
    Some((owner, repo))
}

fn github_http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(GITHUB_ZIP_TIMEOUT_SECS))
        .timeout_write(Duration::from_secs(30))
        .timeout(Duration::from_secs(GITHUB_ZIP_TIMEOUT_SECS + 30))
        .build()
}

fn download_url_to_file(app: Option<&AppHandle>, url: &str, dest: &Path) -> Result<()> {
    ensure_not_cancelled()?;
    let agent = github_http_agent();
    let resp = agent
        .get(url)
        .set("User-Agent", "skill-panel")
        .set("Accept", "application/zip,application/octet-stream,*/*")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => anyhow::anyhow!("HTTP {code}"),
            ureq::Error::Transport(t) => anyhow::anyhow!("{t}"),
        })?;

    let total = resp
        .header("Content-Length")
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0);
    let mut reader = resp.into_reader();
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::File::create(dest).with_context(|| format!("无法写入 {:?}", dest))?;
    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();

    loop {
        ensure_not_cancelled()?;
        let n = reader.read(&mut buf).context("下载中断")?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).context("写入下载文件失败")?;
        downloaded += n as u64;

        if last_emit.elapsed() >= Duration::from_millis(200) {
            let pct = match total {
                Some(t) => (10 + (downloaded.saturating_mul(70) / t.max(1))).min(80) as u8,
                None => 25,
            };
            let msg = match total {
                Some(t) => format!(
                    "下载中 {:.1}/{:.1} MB",
                    downloaded as f64 / 1_048_576.0,
                    t as f64 / 1_048_576.0
                ),
                None => format!("下载中 {:.1} MB", downloaded as f64 / 1_048_576.0),
            };
            emit_progress(app, "download", pct, &msg);
            last_emit = Instant::now();
        }
    }
    file.flush()?;
    if downloaded == 0 {
        anyhow::bail!("下载内容为空");
    }
    Ok(())
}

fn unwrap_archive_root(extract_dir: &Path) -> PathBuf {
    let Ok(entries) = fs::read_dir(extract_dir) else {
        return extract_dir.to_path_buf();
    };
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "__MACOSX" || name.starts_with('.') {
            continue;
        }
        if entry.path().is_dir() {
            dirs.push(entry.path());
        } else {
            return extract_dir.to_path_buf();
        }
    }
    if dirs.len() == 1 {
        dirs.remove(0)
    } else {
        extract_dir.to_path_buf()
    }
}

/// Download a public GitHub repo as zip (avoids git credential hangs on Windows).
fn download_github_zip(
    app: Option<&AppHandle>,
    owner: &str,
    repo: &str,
    dest_root: &Path,
) -> Result<PathBuf> {
    ensure_not_cancelled()?;
    let zip_path = dest_root.join("repo.zip");
    let extract_dir = dest_root.join("extract");
    let _ = fs::remove_file(&zip_path);
    let _ = fs::remove_dir_all(&extract_dir);
    fs::create_dir_all(dest_root)?;

    // HEAD follows the default branch; main/master as fallbacks.
    let candidates = [
        format!("https://codeload.github.com/{owner}/{repo}/zip/refs/heads/main"),
        format!("https://codeload.github.com/{owner}/{repo}/zip/refs/heads/master"),
        format!("https://github.com/{owner}/{repo}/archive/HEAD.zip"),
    ];

    let mut last_err = None;
    for (idx, url) in candidates.iter().enumerate() {
        ensure_not_cancelled()?;
        emit_progress(
            app,
            "download",
            5,
            &format!("从 GitHub 下载 {owner}/{repo}（尝试 {}/{}）…", idx + 1, candidates.len()),
        );
        match download_url_to_file(app, url, &zip_path) {
            Ok(()) => {
                last_err = None;
                break;
            }
            Err(e) => {
                let _ = fs::remove_file(&zip_path);
                last_err = Some(e);
            }
        }
    }
    if let Some(e) = last_err {
        return Err(e).context("GitHub 压缩包下载失败");
    }

    ensure_not_cancelled()?;
    emit_progress(app, "extract", 82, "解压仓库…");
    fs::create_dir_all(&extract_dir)?;
    safe_extract_zip(&zip_path, &extract_dir)?;
    let _ = fs::remove_file(&zip_path);
    let root = unwrap_archive_root(&extract_dir);
    emit_progress(app, "extract", 88, "仓库准备完成");
    Ok(root)
}

fn clone_repo(app: Option<&AppHandle>, url: &str, dest: &Path) -> Result<()> {
    ensure_not_cancelled()?;
    emit_progress(app, "clone", 3, &format!("准备克隆 {url}"));
    if dest.exists() {
        let _ = fs::remove_dir_all(dest);
    }

    // Disable credential helpers / prompts so Windows GCM cannot hang the UI.
    let mut child = git_command()
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_ASKPASS", "echo")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .args([
            "-c",
            "credential.helper=",
            "-c",
            "core.askPass=",
            "clone",
            "--depth",
            "1",
            "--single-branch",
            "--progress",
            url,
        ])
        .arg(dest)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("无法启动 git（请确认已安装 Git 并加入 PATH）")?;

    let stderr = child.stderr.take().context("无法读取 git 输出")?;
    let done = Arc::new(AtomicBool::new(false));
    let done_flag = Arc::clone(&done);
    let app_for_thread = app.cloned();
    let reader = thread::spawn(move || {
        let mut last_msg = String::new();
        for line in BufReader::new(stderr).lines().flatten() {
            if done_flag.load(Ordering::Relaxed) {
                break;
            }
            if let Some((pct, msg)) = parse_git_progress_line(&line) {
                if msg != last_msg {
                    emit_progress(app_for_thread.as_ref(), "clone", pct, &msg);
                    last_msg = msg;
                }
            }
        }
    });

    let started = Instant::now();
    let status = loop {
        if is_install_cancelled() {
            done.store(true, Ordering::Relaxed);
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            let _ = fs::remove_dir_all(dest);
            anyhow::bail!("已取消安装");
        }
        if started.elapsed() > Duration::from_secs(GIT_CLONE_TIMEOUT_SECS) {
            done.store(true, Ordering::Relaxed);
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            anyhow::bail!(
                "克隆超时（{} 秒）。网络可能较慢，或仓库过大/需要登录。可改用本地导入。",
                GIT_CLONE_TIMEOUT_SECS
            );
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(200)),
            Err(e) => {
                done.store(true, Ordering::Relaxed);
                let _ = reader.join();
                anyhow::bail!("等待 git 进程失败：{e}");
            }
        }
    };
    done.store(true, Ordering::Relaxed);
    let _ = reader.join();
    ensure_not_cancelled()?;

    if !status.success() {
        if is_install_cancelled() {
            anyhow::bail!("已取消安装");
        }
        anyhow::bail!(
            "git clone 失败（{url}）。请检查地址、网络，或仓库是否需要登录权限。"
        );
    }
    emit_progress(app, "clone", 88, "仓库克隆完成");
    Ok(())
}

/// Fetch a repo into a temp directory. Prefer GitHub zip (no git / no GCM hang).
/// Returns `(repo_root, cleanup_root)` — delete `cleanup_root` when done.
fn materialize_repo(app: Option<&AppHandle>, url: &str) -> Result<(PathBuf, PathBuf)> {
    let cleanup = tempfile_dir()?;
    let _ = fs::remove_dir_all(&cleanup);
    fs::create_dir_all(&cleanup)?;

    if let Some((owner, repo)) = parse_github_repo(url) {
        match download_github_zip(app, &owner, &repo, &cleanup) {
            Ok(root) => return Ok((root, cleanup)),
            Err(e) => {
                ensure_not_cancelled()?;
                emit_progress(
                    app,
                    "clone",
                    4,
                    &format!("压缩包下载失败（{e}），改用 git clone…"),
                );
                let _ = fs::remove_dir_all(&cleanup);
                fs::create_dir_all(&cleanup)?;
            }
        }
    }

    let clone_dest = cleanup.join("repo");
    if let Err(e) = clone_repo(app, url, &clone_dest) {
        let _ = fs::remove_dir_all(&cleanup);
        return Err(e);
    }
    Ok((clone_dest, cleanup))
}

pub fn install_from_git(
    app: Option<&AppHandle>,
    repo_url: &str,
    subpath: Option<String>,
) -> Result<InstallResult> {
    begin_install_session();
    library::ensure_library()?;
    let url = normalize_git_url(repo_url);
    emit_progress(app, "prepare", 1, "初始化安装…");

    let (repo_root, cleanup) = match materialize_repo(app, &url) {
        Ok(v) => v,
        Err(e) => return Err(e),
    };
    ensure_not_cancelled()?;

    emit_progress(app, "scan", 90, "扫描 Skill…");
    let sub = subpath
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_start_matches('/').trim_start_matches('\\').to_string());
    let whole_repo = sub.is_none();
    let source = match sub {
        Some(p) => {
            let path = repo_root.join(p);
            if !path.exists() {
                let _ = fs::remove_dir_all(&cleanup);
                anyhow::bail!("仓库中不存在子路径：{}", path.display());
            }
            path
        }
        None => repo_root,
    };
    ensure_not_cancelled()?;
    emit_progress(app, "install", 94, "写入技能库…");

    let result = if whole_repo {
        // Whole-repo Git install = ONE package card (mattpocock/skills → 1, not ~40).
        let mut nested = Vec::new();
        if !has_skill_md(&source) {
            scan_skill_dirs(&source, 0, 8, &mut nested);
        }
        if !has_skill_md(&source) && nested.is_empty() {
            let _ = fs::remove_dir_all(&cleanup);
            anyhow::bail!("Git 仓库里没有找到可安装的 Skill");
        }
        let pkg_name = package_name_from_git_url(&url);
        let mut result = InstallResult::default();
        push_install_result(&mut result, &source, Some(&pkg_name));
        for id in &result.installed {
            let _ = record_github_source(id, &url);
        }
        result
    } else {
        install_from_local(&source.to_string_lossy(), None)?
    };

    let _ = fs::remove_dir_all(&cleanup);
    if result.installed.is_empty() && result.skipped.is_empty() {
        if let Some(err) = result.errors.first() {
            anyhow::bail!("{err}");
        }
        anyhow::bail!("Git 仓库里没有找到可安装的 Skill");
    }
    emit_progress(
        app,
        "done",
        100,
        &format!(
            "完成：新装 {}，跳过 {}",
            result.installed.len(),
            result.skipped.len()
        ),
    );
    Ok(result)
}

pub fn install_from_skillssh(
    app: Option<&AppHandle>,
    source: &str,
    skill_id: &str,
) -> Result<InstallResult> {
    begin_install_session();
    library::ensure_library()?;
    let url = format!("https://github.com/{}.git", source.trim().trim_end_matches(".git"));
    emit_progress(app, "prepare", 1, &format!("从 {source} 安装 {skill_id}…"));

    let (repo_root, cleanup) = match materialize_repo(app, &url) {
        Ok(v) => v,
        Err(e) => return Err(e),
    };
    ensure_not_cancelled()?;

    emit_progress(app, "scan", 90, "定位 Skill 目录…");
    let candidates = [
        repo_root.join(skill_id),
        repo_root.join("skills").join(skill_id),
        repo_root.join("skill").join(skill_id),
    ];
    let found = candidates.into_iter().find(|p| has_skill_md(p));
    let Some(found) = found else {
        let _ = fs::remove_dir_all(&cleanup);
        anyhow::bail!(
            "仓库中未找到技能「{skill_id}」（已尝试 {skill_id}、skills/{skill_id}）"
        );
    };

    ensure_not_cancelled()?;
    emit_progress(app, "install", 94, "写入技能库…");
    let mut result = InstallResult::default();
    push_install_result(&mut result, &found, Some(skill_id));
    let _ = fs::remove_dir_all(&cleanup);
    if result.installed.is_empty() && result.skipped.is_empty() {
        if let Some(err) = result.errors.first() {
            anyhow::bail!("{err}");
        }
        anyhow::bail!("安装失败：未写入任何技能");
    }
    emit_progress(app, "done", 100, "安装完成");
    Ok(result)
}

/// Fill missing sources by matching skill id under Cursor/Codex skill dirs.
pub fn backfill_sources_from_agent_dirs() -> Result<usize> {
    library::ensure_library()?;
    let skills = library::list_skills()?;
    let mut meta = library::load_meta()?;
    let mut filled = 0usize;

    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(p) = library::resolve_agent_dir("cursor") {
        roots.push(p);
    }
    if let Ok(p) = library::resolve_agent_dir("codex") {
        roots.push(p);
    }

    for skill in skills {
        if meta.sources.contains_key(&skill.id) {
            continue;
        }
        for root in &roots {
            let candidate = root.join(&skill.id);
            if !has_skill_md(&candidate) {
                continue;
            }
            let source = candidate
                .canonicalize()
                .unwrap_or_else(|_| candidate.clone());
            meta.sources
                .insert(skill.id.clone(), source.to_string_lossy().into_owned());
            if let Ok(fp) = skill_fingerprint(Path::new(&skill.path)) {
                meta.content_hashes.insert(skill.id.clone(), fp);
            }
            filled += 1;
            break;
        }
    }

    if filled > 0 {
        library::save_meta(&meta)?;
    }
    Ok(filled)
}

pub fn check_skill_updates() -> Result<Vec<SkillUpdateInfo>> {
    library::ensure_library()?;
    let _ = backfill_sources_from_agent_dirs();
    let skills = library::list_skills()?;
    let meta = library::load_meta()?;
    let mut out = Vec::new();

    for skill in skills {
        let source_path = meta.sources.get(&skill.id).cloned();
        let local = PathBuf::from(&skill.path);
        let local_fp = if local.exists() {
            skill_fingerprint(&local).ok()
        } else {
            None
        };
        let diverged_from_baseline = meta
            .content_hashes
            .get(&skill.id)
            .zip(local_fp.as_ref())
            .map(|(stored, local)| stored != local)
            .unwrap_or(false);
        let local_modified = skill.local_modified
            || meta.locally_edited.contains(&skill.id)
            || diverged_from_baseline;
        let status = match source_path.as_deref() {
            None => UpdateStatus::MissingSource,
            Some(src) => {
                let src_path = PathBuf::from(src);
                if !src_path.exists() || !has_skill_md(&src_path) {
                    UpdateStatus::SourceGone
                } else {
                    let src_fp = skill_fingerprint(&src_path)?;
                    match local_fp.as_deref() {
                        Some(fp) if fp == src_fp.as_str() => UpdateStatus::UpToDate,
                        _ => UpdateStatus::Outdated,
                    }
                }
            }
        };
        out.push(SkillUpdateInfo {
            skill_id: skill.id.clone(),
            name: skill.display_name.clone(),
            source_path,
            status,
            local_modified,
        });
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

fn backup_skill_markdown(skill_id: &str, dest: &Path) -> Result<Option<PathBuf>> {
    let skill_md = dest.join("SKILL.md");
    let alt = dest.join("skill.md");
    let file = if skill_md.exists() {
        skill_md
    } else if alt.exists() {
        alt
    } else {
        return Ok(None);
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dir = library::backups_dir()?.join(skill_id);
    fs::create_dir_all(&dir)?;
    let backup = dir.join(format!("{stamp}.md"));
    fs::copy(&file, &backup)
        .with_context(|| format!("备份失败: {} -> {}", file.display(), backup.display()))?;
    Ok(Some(backup))
}

pub fn update_skill_from_source(skill_id: &str) -> Result<()> {
    library::ensure_library()?;
    let meta = library::load_meta()?;
    let source = meta
        .sources
        .get(skill_id)
        .cloned()
        .context("该技能没有记录来源路径，请重新导入或先检查更新以尝试补全来源")?;
    let src = PathBuf::from(&source);
    if !src.exists() || !has_skill_md(&src) {
        anyhow::bail!("来源路径不可用：{source}");
    }

    let dest = library::skills_dir()?.join(skill_id);
    if dest.exists() {
        let _ = backup_skill_markdown(skill_id, &dest)?;
        fs::remove_dir_all(&dest)?;
    }
    copy_skill_dir(&src, &dest)?;

    let fp = skill_fingerprint(&dest)?;
    let mut meta = library::load_meta()?;
    let canon = src.canonicalize().unwrap_or(src);
    meta.sources
        .insert(skill_id.to_string(), canon.to_string_lossy().into_owned());
    meta.content_hashes.insert(skill_id.to_string(), fp);
    meta.locally_edited.remove(skill_id);
    library::save_meta(&meta)?;
    Ok(())
}

pub fn update_skills_from_source(skill_ids: &[String]) -> Result<UpdateApplyResult> {
    let mut result = UpdateApplyResult::default();
    for id in skill_ids {
        match update_skill_from_source(id) {
            Ok(()) => result.updated.push(id.clone()),
            Err(e) => result.errors.push(format!("{id}: {e}")),
        }
    }
    Ok(result)
}

/// Find skill roots under a package, even when the package root itself has SKILL.md.
fn collect_nested_skill_dirs(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    scan_nested_skill_dirs(root, 0, 8, &mut found);
    found.sort();
    found.dedup();
    found
}

fn scan_nested_skill_dirs(path: &Path, depth: usize, max_depth: usize, found: &mut Vec<PathBuf>) {
    if depth >= max_depth {
        return;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let child = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_scan_dir(&name) || should_skip_copy_name(&name) {
            continue;
        }
        if !child.is_dir() {
            continue;
        }
        if has_skill_md(&child) {
            found.push(child);
            continue;
        }
        scan_nested_skill_dirs(&child, depth + 1, max_depth, found);
    }
}

pub fn list_nested_skills(skill_id: &str) -> Result<Vec<NestedSkillInfo>> {
    library::ensure_library()?;
    let root = library::skills_dir()?.join(skill_id);
    if !root.is_dir() {
        anyhow::bail!("技能不存在：{skill_id}");
    }
    // Upgrade weak auto-generated package stubs (README-aware) when opening detail.
    let _ = ensure_bundle_skill_md(&root);
    let nested = collect_nested_skill_dirs(&root);
    let mut out = Vec::with_capacity(nested.len());
    for path in nested {
        let id = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "skill".into());
        let rel = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let description = library::read_skill_description(&path);
        let already = find_existing_same_name(&id)?.is_some();
        out.push(NestedSkillInfo {
            rel_path: rel,
            id: id.clone(),
            name: id,
            description,
            already_installed: already,
        });
    }
    Ok(out)
}

/// Extract selected nested sub-skills into the library as independent cards.
pub fn install_nested_skills(skill_id: &str, rel_paths: &[String]) -> Result<InstallResult> {
    library::ensure_library()?;
    let root = library::skills_dir()?.join(skill_id);
    if !root.is_dir() {
        anyhow::bail!("技能不存在：{skill_id}");
    }
    if rel_paths.is_empty() {
        anyhow::bail!("请至少选择一个子技能");
    }

    let parent_folder = {
        let meta = library::load_meta()?;
        meta.skill_folder.get(skill_id).cloned()
    };

    let mut result = InstallResult::default();
    for rel in rel_paths {
        let cleaned = rel.trim().trim_start_matches('/').trim_start_matches('\\');
        if cleaned.is_empty() || cleaned.contains("..") {
            result.errors.push(format!("非法路径：{rel}"));
            continue;
        }
        let path = root.join(cleaned);
        if !path.is_dir() || !has_skill_md(&path) {
            result.errors.push(format!("未找到子技能：{cleaned}"));
            continue;
        }
        let preferred = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "skill".into());
        match install_skill_dir(&path, Some(&preferred)) {
            Ok(one) => {
                if let InstallOne::Installed(ref id) = one {
                    if let Some(ref fid) = parent_folder {
                        let _ = library::set_skill_folder(id, Some(fid.clone()));
                    }
                }
                push_outcome(&mut result, one);
            }
            Err(e) => result.errors.push(format!("{cleaned}: {e}")),
        }
    }

    if result.installed.is_empty()
        && result.skipped.is_empty()
        && !result.errors.is_empty()
    {
        anyhow::bail!("{}", result.errors.join("；"));
    }
    Ok(result)
}

/// Nested skill absolute paths under a library package (for deploy expand).
pub fn nested_skill_paths(skill_id: &str) -> Result<Vec<(String, PathBuf)>> {
    let root = library::skills_dir()?.join(skill_id);
    if !root.is_dir() {
        anyhow::bail!("技能不存在：{skill_id}");
    }
    let mut out = Vec::new();
    for path in collect_nested_skill_dirs(&root) {
        let id = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "skill".into());
        out.push((id, path));
    }
    Ok(out)
}

fn record_github_source(skill_id: &str, url: &str) -> Result<()> {
    let Some((owner, repo)) = parse_github_repo(url) else {
        return Ok(());
    };
    let mut meta = library::load_meta()?;
    meta.sources
        .insert(skill_id.to_string(), format!("github:{owner}/{repo}"));
    library::save_meta(&meta)?;
    Ok(())
}

fn tempfile_dir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
        "skill-panel-clone-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn git_command() -> Command {
    let mut cmd = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

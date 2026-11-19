use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::grsai;
use crate::library::{self, MetaStore, SkillCard};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreMode {
    Replace,
    MergeSkip,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupResult {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreResult {
    pub message: String,
    pub skills: Vec<SkillCard>,
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in WalkDir::new(src).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let rel = path.strip_prefix(src).unwrap_or(path);
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(path, &target)
                .with_context(|| format!("复制失败: {} -> {}", path.display(), target.display()))?;
        }
    }
    Ok(())
}

fn write_ai_settings_redacted(dest: &Path) -> Result<()> {
    let mut settings = grsai::load_ai_settings()?;
    settings.api_key.clear();
    settings.text_api_key.clear();
    settings.image_api_key.clear();
    let raw = serde_json::to_string_pretty(&settings)?;
    fs::write(dest, raw)?;
    Ok(())
}

fn write_backup_contents(out: &Path, stamp: u64) -> Result<()> {
    fs::create_dir_all(out)?;
    copy_dir_recursive(&library::skills_dir()?, &out.join("skills"))?;
    copy_dir_recursive(&library::covers_dir()?, &out.join("covers"))?;
    // Portable meta: cover entries are filenames under covers/, not machine-local absolute paths.
    let mut meta = library::load_meta()?;
    library::normalize_covers_for_export(&mut meta)?;
    fs::write(
        out.join("meta.json"),
        serde_json::to_string_pretty(&meta)?,
    )?;
    write_ai_settings_redacted(&out.join("ai.json"))?;
    let manifest = serde_json::json!({
        "format": "skill-panel-backup",
        "version": 1,
        "exported_at": stamp,
        "includes_api_key": false,
        "includes_covers": true
    });
    fs::write(out.join("backup.json"), serde_json::to_string_pretty(&manifest)?)?;
    Ok(())
}

fn zip_dir(src_dir: &Path, zip_path: &Path) -> Result<()> {
    let file = fs::File::create(zip_path)
        .with_context(|| format!("创建 zip 失败: {}", zip_path.display()))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut buffer = Vec::new();

    for entry in WalkDir::new(src_dir).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let name = path
            .strip_prefix(src_dir)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        if name.is_empty() {
            continue;
        }
        if entry.file_type().is_dir() {
            let dir_name = if name.ends_with('/') {
                name
            } else {
                format!("{name}/")
            };
            zip.add_directory(dir_name, options)?;
        } else if entry.file_type().is_file() {
            zip.start_file(name, options)?;
            buffer.clear();
            fs::File::open(path)?.read_to_end(&mut buffer)?;
            zip.write_all(&buffer)?;
        }
    }
    zip.finish()?;
    Ok(())
}

fn unzip_to(zip_path: &Path, dest: &Path) -> Result<()> {
    fs::create_dir_all(dest)?;
    let file = fs::File::open(zip_path)?;
    let mut archive = ZipArchive::new(file)?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let outpath = match file.enclosed_name() {
            Some(p) => dest.join(p),
            None => continue,
        };
        if file.name().ends_with('/') {
            fs::create_dir_all(&outpath)?;
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut outfile = fs::File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
        }
    }
    Ok(())
}

/// Export library to a zip file or a folder. API key is never included.
pub fn export_library(dest: &str, as_folder: bool) -> Result<BackupResult> {
    library::ensure_library()?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dest_path = PathBuf::from(dest);

    if as_folder {
        let out = if dest_path.extension().is_some() {
            dest_path.with_extension("")
        } else {
            dest_path
        };
        let out = if out.exists() {
            PathBuf::from(format!("{}-{}", out.display(), stamp))
        } else {
            out
        };
        write_backup_contents(&out, stamp)?;
        return Ok(BackupResult {
            path: out.to_string_lossy().into_owned(),
            message: format!("已导出文件夹：{}", out.display()),
        });
    }

    let zip_path = if dest_path.extension().and_then(|e| e.to_str()) == Some("zip") {
        dest_path
    } else {
        PathBuf::from(format!("{}.zip", dest_path.display()))
    };
    let staging = std::env::temp_dir().join(format!("skill-panel-backup-{stamp}"));
    let _ = fs::remove_dir_all(&staging);
    write_backup_contents(&staging, stamp)?;
    if let Some(parent) = zip_path.parent() {
        fs::create_dir_all(parent)?;
    }
    zip_dir(&staging, &zip_path)?;
    let _ = fs::remove_dir_all(&staging);
    Ok(BackupResult {
        path: zip_path.to_string_lossy().into_owned(),
        message: format!("已导出 ZIP：{}", zip_path.display()),
    })
}

fn merge_meta(current: &mut MetaStore, incoming: MetaStore) {
    for (k, v) in incoming.tags {
        current.tags.entry(k).or_insert(v);
    }
    for id in incoming.pinned {
        current.pinned.insert(id);
    }
    for f in incoming.folders {
        if !current.folders.iter().any(|x| x.id == f.id) {
            current.folders.push(f);
        }
    }
    for (k, v) in incoming.skill_folder {
        current.skill_folder.entry(k).or_insert(v);
    }
    for (k, v) in incoming.covers {
        current.covers.entry(k).or_insert(v);
    }
    for (k, v) in incoming.description_zh {
        current.description_zh.entry(k).or_insert(v);
    }
    for (k, v) in incoming.display_names {
        current.display_names.entry(k).or_insert(v);
    }
    for (k, v) in incoming.sources {
        current.sources.entry(k).or_insert(v);
    }
    for (k, v) in incoming.content_hashes {
        current.content_hashes.entry(k).or_insert(v);
    }
    for id in incoming.locally_edited {
        current.locally_edited.insert(id);
    }
    for (k, v) in incoming.imported_at {
        current.imported_at.entry(k).or_insert(v);
    }
}

fn finalize_imported_covers() -> Result<()> {
    let mut meta = library::load_meta()?;
    if library::remap_covers_to_local(&mut meta)? {
        library::save_meta(&meta)?;
    }
    Ok(())
}

fn restore_ai_settings_keep_keys(src: &Path) -> Result<()> {
    let ai_src = src.join("ai.json");
    if !ai_src.is_file() {
        return Ok(());
    }
    let mut incoming: grsai::AiSettings =
        serde_json::from_str(&fs::read_to_string(&ai_src).unwrap_or_else(|_| "{}".into()))
            .unwrap_or_default();
    let local = grsai::load_ai_settings().unwrap_or_default();
    incoming.api_key = local.api_key.clone();
    incoming.text_api_key = local.text_api_key.clone();
    incoming.image_api_key = local.image_api_key.clone();
    if incoming.prompt_text.trim().is_empty() {
        incoming.prompt_text = local.prompt_text.clone();
    }
    if incoming.prompt_image.trim().is_empty() {
        incoming.prompt_image = local.prompt_image.clone();
    }
    grsai::save_ai_settings(&incoming)?;
    Ok(())
}

fn swap_dir(live: &Path, incoming: &Path, trash: &Path) -> Result<()> {
    if trash.exists() {
        fs::remove_dir_all(trash)?;
    }
    if live.exists() {
        fs::rename(live, trash)
            .with_context(|| format!("无法暂存旧目录: {}", live.display()))?;
    }
    fs::rename(incoming, live)
        .with_context(|| format!("无法切换新目录: {}", incoming.display()))?;
    Ok(())
}

fn import_from_dir(src: &Path, mode: RestoreMode) -> Result<RestoreResult> {
    let skills_src = src.join("skills");
    let covers_src = src.join("covers");
    let meta_src = src.join("meta.json");
    if !skills_src.is_dir() || !meta_src.is_file() {
        bail!("不是有效的 Skill Panel 备份（缺少 skills/ 或 meta.json）");
    }

    library::ensure_library()?;
    let root = library::root_dir()?;
    let skills_dst = library::skills_dir()?;
    let covers_dst = library::covers_dir()?;

    match mode {
        RestoreMode::Replace => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let skills_in = root.join(format!(".skills.incoming-{stamp}"));
            let covers_in = root.join(format!(".covers.incoming-{stamp}"));
            let skills_old = root.join(format!(".skills.trash-{stamp}"));
            let covers_old = root.join(format!(".covers.trash-{stamp}"));
            let meta_in = root.join(format!(".meta.incoming-{stamp}.json"));

            let _ = fs::remove_dir_all(&skills_in);
            let _ = fs::remove_dir_all(&covers_in);
            fs::create_dir_all(&skills_in)?;
            fs::create_dir_all(&covers_in)?;

            // Stage fully before touching the live library.
            copy_dir_recursive(&skills_src, &skills_in)?;
            if covers_src.is_dir() {
                copy_dir_recursive(&covers_src, &covers_in)?;
            }
            fs::copy(&meta_src, &meta_in)?;

            swap_dir(&skills_dst, &skills_in, &skills_old)?;
            if let Err(e) = swap_dir(&covers_dst, &covers_in, &covers_old) {
                // Best-effort rollback of skills if covers swap fails.
                let _ = swap_dir(&skills_dst, &skills_old, &skills_in);
                let _ = fs::remove_dir_all(&covers_in);
                let _ = fs::remove_file(&meta_in);
                return Err(e);
            }

            fs::copy(&meta_in, library::meta_path()?)?;
            let _ = fs::remove_file(&meta_in);
            let _ = restore_ai_settings_keep_keys(src);
            let _ = fs::remove_dir_all(&skills_old);
            let _ = fs::remove_dir_all(&covers_old);
            // Bind cover filenames / legacy absolute paths to this machine's covers/.
            finalize_imported_covers()?;

            Ok(RestoreResult {
                message: "已整库替换恢复（含封面）".into(),
                skills: library::list_skills()?,
            })
        }
        RestoreMode::MergeSkip => {
            if skills_src.is_dir() {
                for entry in fs::read_dir(&skills_src)?.flatten() {
                    let name = entry.file_name();
                    let target = skills_dst.join(&name);
                    if target.exists() {
                        continue;
                    }
                    if entry.path().is_dir() {
                        copy_dir_recursive(&entry.path(), &target)?;
                    }
                }
            }
            if covers_src.is_dir() {
                fs::create_dir_all(&covers_dst)?;
                for entry in fs::read_dir(&covers_src)?.flatten() {
                    let target = covers_dst.join(entry.file_name());
                    if target.exists() {
                        continue;
                    }
                    if entry.path().is_file() {
                        let _ = fs::copy(entry.path(), target);
                    }
                }
            }
            let incoming: MetaStore =
                serde_json::from_str(&fs::read_to_string(&meta_src).unwrap_or_else(|_| "{}".into()))
                    .unwrap_or_default();
            let mut current = library::load_meta()?;
            merge_meta(&mut current, incoming);
            library::save_meta(&current)?;
            finalize_imported_covers()?;
            Ok(RestoreResult {
                message: "已合并恢复（同名技能已跳过，含封面）".into(),
                skills: library::list_skills()?,
            })
        }
    }
}

pub fn import_library(source: &str, mode: RestoreMode) -> Result<RestoreResult> {
    let path = PathBuf::from(source);
    if !path.exists() {
        bail!("备份路径不存在");
    }
    if path.is_dir() {
        return import_from_dir(&path, mode);
    }
    if path.extension().and_then(|e| e.to_str()) == Some("zip") {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let staging = std::env::temp_dir().join(format!("skill-panel-restore-{stamp}"));
        let _ = fs::remove_dir_all(&staging);
        unzip_to(&path, &staging)?;
        let result = import_from_dir(&staging, mode);
        let _ = fs::remove_dir_all(&staging);
        return result;
    }
    bail!("请选择 .zip 备份或备份文件夹");
}

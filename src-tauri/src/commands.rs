use crate::apply::{self, ApplyResult};
use crate::backup::{self, BackupResult, RestoreMode, RestoreResult};
use crate::grsai::{self, AiSettingsPublic, AiSettingsSave};
use crate::install::{self, InstallResult, NestedSkillInfo, SkillUpdateInfo, UpdateApplyResult};
use crate::library::{self, AppPaths, Folder, MetaStore, SkillCard};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub fn get_paths() -> Result<AppPaths, String> {
    library::ensure_library().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_skills() -> Result<Vec<SkillCard>, String> {
    library::ensure_library().map_err(|e| e.to_string())?;
    library::list_skills().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_tags() -> Result<Vec<String>, String> {
    library::all_tags().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_folders() -> Result<Vec<Folder>, String> {
    library::list_folders().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_folder(name: String) -> Result<Vec<Folder>, String> {
    library::create_folder(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_folder(folder_id: String, name: String) -> Result<Vec<Folder>, String> {
    library::rename_folder(&folder_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_folder(folder_id: String) -> Result<Vec<Folder>, String> {
    library::delete_folder(&folder_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_skill_folder(
    skill_id: String,
    folder_id: Option<String>,
) -> Result<Vec<SkillCard>, String> {
    library::set_skill_folder(&skill_id, folder_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_skill_description_zh(
    skill_id: String,
    text: String,
) -> Result<Vec<SkillCard>, String> {
    library::set_skill_description_zh(&skill_id, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_skill_cover(skill_id: String, source_path: String) -> Result<Vec<SkillCard>, String> {
    library::set_skill_cover(&skill_id, &source_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_skill_cover(skill_id: String) -> Result<Vec<SkillCard>, String> {
    library::clear_skill_cover(&skill_id).map_err(|e| e.to_string())
}

/// Native image picker + set cover (more reliable under always-on-top).
#[tauri::command]
pub fn pick_and_set_skill_cover(
    app: AppHandle,
    skill_id: String,
) -> Result<Option<Vec<SkillCard>>, String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_always_on_top(false);
        let _ = win.set_focus();
    }

    let picked = app
        .dialog()
        .file()
        .set_title("选择封面图片")
        .add_filter("Image", &["png", "jpg", "jpeg", "webp", "gif", "bmp"])
        .blocking_pick_file();

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_always_on_top(true);
        let _ = win.set_focus();
    }

    let Some(file) = picked else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|e| format!("无法读取所选图片：{e}"))?;
    let list = library::set_skill_cover(&skill_id, &path.to_string_lossy())
        .map_err(|e| e.to_string())?;
    Ok(Some(list))
}

#[tauri::command]
pub fn set_skill_tags(skill_id: String, tags: Vec<String>) -> Result<Vec<SkillCard>, String> {
    library::set_skill_tags(&skill_id, tags).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_skill_display_name(
    skill_id: String,
    name: String,
) -> Result<Vec<SkillCard>, String> {
    library::set_skill_display_name(&skill_id, name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_skill_markdown(skill_id: String) -> Result<String, String> {
    library::read_skill_markdown(&skill_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_skill_markdown(
    skill_id: String,
    content: String,
) -> Result<Vec<SkillCard>, String> {
    library::write_skill_markdown(&skill_id, &content).map_err(|e| e.to_string())?;
    library::list_skills().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_pin(skill_id: String) -> Result<Vec<SkillCard>, String> {
    library::toggle_pin(&skill_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_meta() -> Result<MetaStore, String> {
    library::load_meta().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_meta(meta: MetaStore) -> Result<(), String> {
    library::save_meta(&meta).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn apply_skill(
    app: AppHandle,
    skill_id: String,
    agent: String,
    copy_only: bool,
    auto_paste: bool,
    expand_nested: Option<bool>,
) -> Result<ApplyResult, String> {
    let expand = expand_nested.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        apply::apply_skill(&app, &skill_id, &agent, copy_only, auto_paste, expand)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("应用任务中断：{e}"))?
}

#[tauri::command]
pub async fn list_nested_skills(skill_id: String) -> Result<Vec<NestedSkillInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install::list_nested_skills(&skill_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("扫描中断：{e}"))?
}

#[tauri::command]
pub async fn install_nested_skills(
    skill_id: String,
    rel_paths: Vec<String>,
) -> Result<InstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install::install_nested_skills(&skill_id, &rel_paths).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("安装任务中断：{e}"))?
}

#[tauri::command]
pub async fn install_local(path: String, name: Option<String>) -> Result<InstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install::install_from_local(&path, name).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("安装任务中断：{e}"))?
}

/// Native folder picker + install. More reliable than JS dialog under always-on-top.
#[tauri::command]
pub async fn pick_and_install_local(app: AppHandle) -> Result<InstallResult, String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_always_on_top(false);
        let _ = win.set_focus();
    }

    let app_for_dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog
            .dialog()
            .file()
            .set_title("选择技能目录（可选上级文件夹，自动批量扫描）")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("选择目录中断：{e}"))?;

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_always_on_top(true);
        let _ = win.set_focus();
    }

    let Some(folder) = picked else {
        return Ok(InstallResult::default());
    };

    let path = folder
        .into_path()
        .map_err(|e| format!("无法读取所选路径：{e}"))?;
    let path_str = path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        install::install_from_local(&path_str, None).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("安装任务中断：{e}"))?
}

#[tauri::command]
pub async fn install_git(
    app: AppHandle,
    repo_url: String,
    subpath: Option<String>,
) -> Result<InstallResult, String> {
    // Blocking network / git — keep off the async runtime (same pattern as AI commands).
    tauri::async_runtime::spawn_blocking(move || {
        install::install_from_git(Some(&app), &repo_url, subpath).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("安装任务中断：{e}"))?
}

#[tauri::command]
pub async fn install_skillssh(
    app: AppHandle,
    source: String,
    skill_id: String,
) -> Result<InstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install::install_from_skillssh(Some(&app), &source, &skill_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("安装任务中断：{e}"))?
}

#[tauri::command]
pub fn cancel_install() -> Result<(), String> {
    install::request_cancel_install();
    Ok(())
}

#[tauri::command]
pub fn delete_skill(skill_id: String) -> Result<Vec<SkillCard>, String> {
    library::delete_skill(&skill_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_skill_updates() -> Result<Vec<SkillUpdateInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        install::check_skill_updates().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("检查更新中断：{e}"))?
}

#[tauri::command]
pub async fn update_skill(skill_id: String) -> Result<Vec<SkillCard>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install::update_skill_from_source(&skill_id).map_err(|e| e.to_string())?;
        library::list_skills().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("更新中断：{e}"))?
}

#[tauri::command]
pub async fn update_skills(skill_ids: Vec<String>) -> Result<UpdateApplyResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install::update_skills_from_source(&skill_ids).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("更新中断：{e}"))?
}

#[tauri::command]
pub async fn backfill_skill_sources() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(|| {
        install::backfill_sources_from_agent_dirs().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("回填中断：{e}"))?
}

#[tauri::command]
pub fn open_library_folder() -> Result<String, String> {
    let paths = library::ensure_library().map_err(|e| e.to_string())?;
    Ok(paths.skills)
}

#[tauri::command]
pub fn get_ai_settings() -> Result<AiSettingsPublic, String> {
    grsai::get_ai_settings_public().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_ai_settings(settings: AiSettingsSave) -> Result<AiSettingsPublic, String> {
    grsai::update_ai_settings(settings).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reset_ai_prompts() -> Result<AiSettingsPublic, String> {
    grsai::reset_ai_prompts().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_ai_connection() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| grsai::test_ai_connection().map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("测试中断：{e}"))?
}

#[tauri::command]
pub fn cancel_ai() -> Result<(), String> {
    grsai::request_cancel_ai();
    Ok(())
}

#[tauri::command]
pub fn clear_ai_cancel() -> Result<(), String> {
    grsai::clear_ai_cancel();
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct GenerateDescriptionResult {
    pub text: String,
    pub skills: Vec<SkillCard>,
}

#[tauri::command]
pub async fn generate_skill_description(
    app: AppHandle,
    skill_id: String,
) -> Result<GenerateDescriptionResult, String> {
    // ureq is blocking — keep it off the UI / async runtime thread
    let result = tauri::async_runtime::spawn_blocking(move || {
        grsai::generate_skill_description(&skill_id, Some(&app)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("生成任务中断：{e}"))?;
    let (text, skills) = result?;
    Ok(GenerateDescriptionResult { text, skills })
}

#[tauri::command]
pub async fn generate_skill_cover(
    app: AppHandle,
    skill_id: String,
) -> Result<Vec<SkillCard>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        grsai::generate_skill_cover(&skill_id, Some(&app)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("生成任务中断：{e}"))?
}

#[tauri::command]
pub async fn export_library(dest: String, as_folder: bool) -> Result<BackupResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        backup::export_library(&dest, as_folder).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("导出中断：{e}"))?
}

#[tauri::command]
pub async fn import_library(source: String, mode: String) -> Result<RestoreResult, String> {
    let restore_mode = match mode.as_str() {
        "replace" => RestoreMode::Replace,
        "merge_skip" | "merge" => RestoreMode::MergeSkip,
        _ => return Err("未知恢复模式".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        backup::import_library(&source, restore_mode).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("导入中断：{e}"))?
}

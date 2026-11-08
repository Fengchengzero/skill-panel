use anyhow::Result;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::thread;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::deploy;
use crate::library;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ApplyResult {
    pub invoke: String,
    pub deployed_to: Option<String>,
    pub pasted: bool,
    pub message: String,
}

pub fn apply_skill(
    app: &AppHandle,
    skill_id: &str,
    agent: &str,
    copy_only: bool,
    auto_paste: bool,
) -> Result<ApplyResult> {
    let invoke = format!("${skill_id}");
    let mut deployed_to = None;

    if !copy_only && agent != "chatgpt" {
        let dest = deploy::deploy_skill(skill_id, agent)?;
        deployed_to = Some(dest.to_string_lossy().into_owned());
    }

    app.clipboard()
        .write_text(invoke.clone())
        .map_err(|e| anyhow::anyhow!("Clipboard write failed: {e}"))?;

    let mut pasted = false;
    if auto_paste && !copy_only {
        // Give the user a beat to keep focus on the agent window.
        thread::sleep(Duration::from_millis(180));
        pasted = try_paste().unwrap_or(false);
    }

    let message = if copy_only {
        format!("已复制 {invoke}")
    } else if agent == "chatgpt" {
        format!("已复制 {invoke}（ChatGPT 仅粘贴）")
    } else if pasted {
        format!("已部署并尝试粘贴 {invoke}")
    } else {
        format!("已部署并复制 {invoke}，请手动 Ctrl+V")
    };

    let _ = library::list_skills()?;
    Ok(ApplyResult {
        invoke,
        deployed_to,
        pasted,
        message,
    })
}

fn try_paste() -> Result<bool> {
    let mut enigo = Enigo::new(&Settings::default())?;
    #[cfg(target_os = "macos")]
    {
        enigo.key(Key::Meta, Direction::Press)?;
        enigo.key(Key::Unicode('v'), Direction::Click)?;
        enigo.key(Key::Meta, Direction::Release)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        enigo.key(Key::Control, Direction::Press)?;
        enigo.key(Key::Unicode('v'), Direction::Click)?;
        enigo.key(Key::Control, Direction::Release)?;
    }
    Ok(true)
}

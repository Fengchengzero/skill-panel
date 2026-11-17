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
    #[serde(default)]
    pub expanded: Vec<String>,
    pub pasted: bool,
    pub message: String,
}

fn paste_hint() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Cmd+V"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Ctrl+V"
    }
}

/// Cursor/Codex use folder id; ChatGPT prefers SKILL.md frontmatter `name:`.
fn resolve_invoke(skill_id: &str, agent: &str) -> String {
    if agent == "chatgpt" {
        if let Ok(doc_name) = library::read_skill_frontmatter_name(skill_id) {
            let trimmed = doc_name.trim();
            if !trimmed.is_empty() {
                return format!("${trimmed}");
            }
        }
    }
    format!("${skill_id}")
}

pub fn apply_skill(
    app: &AppHandle,
    skill_id: &str,
    agent: &str,
    copy_only: bool,
    auto_paste: bool,
    expand_nested: bool,
) -> Result<ApplyResult> {
    let invoke = resolve_invoke(skill_id, agent);
    let mut deployed_to = None;
    let mut expanded = Vec::new();

    if !copy_only && agent != "chatgpt" {
        let result = deploy::deploy_skill(skill_id, agent, expand_nested)?;
        deployed_to = Some(result.package_path);
        expanded = result.expanded;
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

    let expand_note = if expanded.is_empty() {
        String::new()
    } else {
        format!("；已展开 {} 个子技能到 Agent", expanded.len())
    };

    let hint = paste_hint();
    let message = if copy_only {
        format!("已复制 {invoke}")
    } else if agent == "chatgpt" {
        if pasted {
            format!("已复制并尝试粘贴 {invoke}（ChatGPT 不部署）")
        } else if auto_paste {
            format!("已复制 {invoke}（ChatGPT 不部署），请手动 {hint}")
        } else {
            format!("已复制 {invoke}（ChatGPT 不部署）")
        }
    } else if pasted {
        format!("已部署并尝试粘贴 {invoke}{expand_note}")
    } else if auto_paste {
        format!("已部署并复制 {invoke}，请手动 {hint}{expand_note}")
    } else {
        format!("已部署并复制 {invoke}{expand_note}")
    };

    let _ = library::list_skills()?;
    Ok(ApplyResult {
        invoke,
        deployed_to,
        expanded,
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

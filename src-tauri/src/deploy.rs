use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

use crate::library;

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == ".git" || name_str == ".DS_Store" {
            continue;
        }
        if ft.is_symlink() {
            continue;
        }
        let target = dst.join(&name);
        if ft.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &target)
                .with_context(|| format!("Failed to copy {:?} -> {:?}", entry.path(), target))?;
        }
    }
    Ok(())
}

pub fn deploy_skill(skill_id: &str, agent: &str) -> Result<PathBuf> {
    let skills = library::skills_dir()?;
    let source = skills.join(skill_id);
    if !source.is_dir() {
        anyhow::bail!("Skill not found in library: {skill_id}");
    }
    let agent_dir = library::resolve_agent_dir(agent)?;
    fs::create_dir_all(&agent_dir)?;
    let dest = agent_dir.join(skill_id);
    if dest.exists() {
        fs::remove_dir_all(&dest)
            .with_context(|| format!("Failed to replace existing deploy at {:?}", dest))?;
    }
    copy_dir(&source, &dest)?;
    Ok(dest)
}

use anyhow::{Context, Result};
use std::fs;
use std::path::Path;

use crate::install;
use crate::library;

fn should_skip_name(name: &str) -> bool {
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
            | ".DS_Store"
            | "package-lock.json"
            | "yarn.lock"
            | "pnpm-lock.yaml"
    )
}

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if should_skip_name(&name_str) {
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

fn deploy_path(src: &Path, dest: &Path) -> Result<()> {
    if dest.exists() {
        fs::remove_dir_all(dest)
            .with_context(|| format!("Failed to replace existing deploy at {:?}", dest))?;
    }
    copy_dir(src, dest)?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeployResult {
    pub package_path: String,
    pub expanded: Vec<String>,
}

pub fn deploy_skill(skill_id: &str, agent: &str, expand_nested: bool) -> Result<DeployResult> {
    let skills = library::skills_dir()?;
    let source = skills.join(skill_id);
    if !source.is_dir() {
        anyhow::bail!("Skill not found in library: {skill_id}");
    }
    let agent_dir = library::resolve_agent_dir(agent)?;
    fs::create_dir_all(&agent_dir)?;

    let dest = agent_dir.join(skill_id);
    deploy_path(&source, &dest)?;

    let mut expanded = Vec::new();
    if expand_nested {
        let nested = install::nested_skill_paths(skill_id).unwrap_or_default();
        for (id, path) in nested {
            if id == skill_id {
                continue;
            }
            let nested_dest = agent_dir.join(&id);
            deploy_path(&path, &nested_dest)?;
            expanded.push(id);
        }
    }

    Ok(DeployResult {
        package_path: dest.to_string_lossy().into_owned(),
        expanded,
    })
}

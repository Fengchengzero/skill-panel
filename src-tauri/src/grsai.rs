use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::library::{self, SkillCard};

static AI_CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn request_cancel_ai() {
    AI_CANCELLED.store(true, Ordering::SeqCst);
}

pub fn clear_ai_cancel() {
    AI_CANCELLED.store(false, Ordering::SeqCst);
}

pub fn ai_cancelled() -> bool {
    AI_CANCELLED.load(Ordering::SeqCst)
}

fn ensure_not_cancelled() -> Result<()> {
    if ai_cancelled() {
        bail!("已取消");
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct AiProgress {
    pub kind: String,
    pub skill_id: String,
    pub stage: String,
    pub percent: u32,
    pub message: String,
}

fn emit_progress(
    app: Option<&AppHandle>,
    kind: &str,
    skill_id: &str,
    stage: &str,
    percent: u32,
    message: &str,
) {
    if let Some(app) = app {
        let _ = app.emit(
            "ai-progress",
            AiProgress {
                kind: kind.into(),
                skill_id: skill_id.into(),
                stage: stage.into(),
                percent,
                message: message.into(),
            },
        );
    }
}

fn write_last_error(msg: &str) {
    if let Ok(root) = library::root_dir() {
        let path = root.join("ai-last-error.log");
        let _ = fs::write(
            path,
            format!(
                "{}\n{}\n",
                chrono_like_now(),
                msg
            ),
        );
    }
}

fn chrono_like_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix:{secs}")
}

pub const DEFAULT_BASE_URL: &str = "https://grsai.dakka.com.cn/v1";
pub const DEFAULT_TEXT_MODEL: &str = "gemini-2.5-flash-lite";
pub const DEFAULT_IMAGE_MODEL: &str = "gpt-image-2.6";
pub const DEFAULT_IMAGE_ASPECT: &str = "16:9";
pub const DEFAULT_IMAGE_RESOLUTION: &str = "4K";

pub const OPENAI_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
pub const OPENAI_DEFAULT_IMAGE_MODEL: &str = "dall-e-3";

/// Image API wire format (text always uses OpenAI-compatible `/chat/completions`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AiProvider {
    /// GrsAI / dakka — may use `/api/generate` async for gpt-image / nano-banana.
    #[default]
    Grsai,
    /// OpenAI-compatible `/images/generations`.
    Openai,
}

fn default_provider() -> AiProvider {
    AiProvider::Grsai
}

fn key_hint(key: &str) -> String {
    let key = key.trim();
    if key.is_empty() {
        return String::new();
    }
    let tail = if key.len() > 4 {
        &key[key.len() - 4..]
    } else {
        key
    };
    format!("••••{tail}")
}

pub const DEFAULT_PROMPT_TEXT: &str = r#"# Role
你是一个极简、专业的 AI 技能（Skill）文档精简专家。你的任务是阅读用户上传的 `skill.md` 技能定义文件，并为 Skill 管理工具卡片提取并生成一段【极简、高信息密度的中文概述】（限 40-70 字）。

# Constraints & Rules
1. 长度限制：必须在 40 到 70 字之间（包含标点），多一个字都会破坏 UI，请极其克制。
2. 语气风格：客观、专业、干练，使用动宾结构或流程化描述。严禁使用“本技能可以...”、“本工具旨在...”等废话，直接切入核心。
3. 核心内容必须包含：
   - 输入：它处理什么输入（如：单张俯视图 / 曲线 / 文本）？
   - 过程与工具：它在什么平台、用什么逻辑处理（如：基于像素标定、Rhino、Python 等）？
   - 产出：它最终生成/完成了什么（如：全三维立交场地、干扰幕墙）？
   - 价值：它的独特优势/标准是什么（如：防碰撞、100mm路缘、符合规范等）？

# Generation Template (内部思考，直接输出最终文本)
不要带任何“好的”、“摘要如下”等前缀。直接输出精简概述。

示例1 (城市场地):
依据单张俯视图像素标定，在 Rhino 中自动推求真实路宽，快速生成带 100mm 路缘、道路标线及复杂三维立交桥的完整城市场地模型。

示例2 (幕墙干扰):
读取 Rhino 目标曲面与干扰源，利用 Grasshopper/Python 自动计算渐变干扰逻辑，快速生成具备参数化开孔、遮阳转折的定制化建筑幕墙。

# Degradation Strategy
如果 `skill.md` 缺少实质内容或过于简略，请根据仅有的标题和标签，生成一句最合理的通用功能推测，切勿报错或输出空白。"#;

pub const DEFAULT_PROMPT_IMAGE: &str = r#"# Role
你是一个资深 AI 视觉创意总监和 UI 插画 prompt 专家。你的任务是阅读用户上传的 `skill.md`，分析其“输入”和“输出”的物理/视觉载体，并将其转化为一段为 AI 绘图模型（如 Midjourney / DALL-E 3）量身定制的、具有强烈 UI 卡片感的高质量图像描述词（Image Generation Prompt）。

# Visual Identity & Style (视觉规范)
为了确保 Skill 卡片在管理工具中的一致性和高级感，生成的 Prompt 必须遵循以下视觉规范：
- 视角：3D Isometric (等轴测视角) 或 3/4 perspective (透视视角)，微缩模型感。
- 风格：Minimal modern UI card illustration (极简现代 UI 卡片插图), 3D clay model or digital rendering.
- 色调：极简、亮堂。浅灰（#F5F6F8）、浅蓝、白为主，辅以少量功能性高亮（如黄、青）。
- 留白：下方 30% 及右下角大面积留白/渐变（为 UI 文字预留空间）。
- 对比逻辑（核心）：采用“左侧 2D/输入/草图 ➔ 右侧 3D/输出/生成结果”的“进化”式对比构图，中间用淡色箭头 “➔” 衔接。

# Analysis Steps (你如何分析 skill.md)
1. Identify the Core Skill: 提取该技能的名称和一句话本质（如：俯视图转 3D 场地）。
2. Pinpoint the "Input" (左侧): 它拿什么作为起点？是手绘、2D 平面图、一条曲线、还是代码？（转化为视觉元素，如“带黄色尺寸标注的 2D 规划图纸”）。
3. Pinpoint the "Output" (右侧): 它最终生成了什么具体的、有视觉冲击力的东西？（转化为视觉元素，如“多层交叠的 3D 桥梁、带路缘的马路和建筑体量”）。
4. Ensure Scale/Tech Details: 增加一些技术感元素（如网格线、微缩尺寸标注、亮色标签，例如 `INPUT: TOP-VIEW` & `OUTPUT: 3D MODEL`）。

# Output Format (只输出英文 Image Prompt)
请你仔细阅读 `skill.md`，然后直接输出一段英文 Image Prompt，不要包含任何多余解释。格式如下：

[Prompt] = A minimal modern UI card illustration for an architectural/computational design tool, 16:9 aspect ratio, on a clean light gray and soft blue gradient background with subtle grid lines. Natural diffused studio lighting with gentle shadows.

- Left Side (INPUT): A tilted, floating [描述2D/原始输入的视觉，例如: 2D flat blueprint / a single curve / code viewport] with micro yellow/cyan dimension markings, and a small label "[输入标签，例如: INPUT: TOP-VIEW IMAGE]". A subtle, glowing transformation arrow [➔] points to the right.

- Right Side (OUTPUT): A highly detailed, 3D isometric Rhino-style model [描述3D/最终输出的视觉，例如: of a complex highway interchange with rampways, gray asphalt, 100mm kerbs, and surrounding architectural massing] growing out of the base. Crisp digital "Shaded" style with tiny polygons, visual annotation tags, and a small label "[输出标签，例如: OUTPUT: 3D RHINO MODEL]".

- Visual Style: Tech-craft aesthetics, micro-scales, 3D miniature, isometric, ultra-clean. Generous negative space and soft gradients at the bottom 30% for text overlays. No clutter, high-end UI portfolio design. --ar 16:9"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSettings {
    /// Legacy shared key (migrated into text_/image_ on load).
    #[serde(default)]
    pub api_key: String,
    /// Legacy shared provider (migrated into image_provider on load).
    #[serde(default = "default_provider")]
    pub provider: AiProvider,
    /// Legacy shared base URL (migrated into text_/image_ on load).
    #[serde(default = "default_base_url")]
    pub base_url: String,

    #[serde(default)]
    pub text_api_key: String,
    #[serde(default)]
    pub text_base_url: String,
    #[serde(default = "default_text_model")]
    pub text_model: String,

    #[serde(default)]
    pub image_api_key: String,
    #[serde(default = "default_provider")]
    pub image_provider: AiProvider,
    #[serde(default)]
    pub image_base_url: String,
    #[serde(default = "default_image_model")]
    pub image_model: String,
    #[serde(default = "default_image_aspect")]
    pub image_aspect: String,
    #[serde(default = "default_image_resolution")]
    pub image_resolution: String,

    #[serde(default = "default_prompt_text")]
    pub prompt_text: String,
    #[serde(default = "default_prompt_image")]
    pub prompt_image: String,
}

fn default_base_url() -> String {
    DEFAULT_BASE_URL.into()
}
fn default_text_model() -> String {
    DEFAULT_TEXT_MODEL.into()
}
fn default_image_model() -> String {
    DEFAULT_IMAGE_MODEL.into()
}
fn default_image_aspect() -> String {
    DEFAULT_IMAGE_ASPECT.into()
}
fn default_image_resolution() -> String {
    DEFAULT_IMAGE_RESOLUTION.into()
}
fn default_prompt_text() -> String {
    DEFAULT_PROMPT_TEXT.into()
}
fn default_prompt_image() -> String {
    DEFAULT_PROMPT_IMAGE.into()
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            provider: default_provider(),
            base_url: default_base_url(),
            text_api_key: String::new(),
            text_base_url: DEFAULT_BASE_URL.into(),
            text_model: default_text_model(),
            image_api_key: String::new(),
            image_provider: default_provider(),
            image_base_url: DEFAULT_BASE_URL.into(),
            image_model: default_image_model(),
            image_aspect: default_image_aspect(),
            image_resolution: default_image_resolution(),
            prompt_text: default_prompt_text(),
            prompt_image: default_prompt_image(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSettingsPublic {
    pub text_base_url: String,
    pub text_model: String,
    pub text_api_key_set: bool,
    pub text_api_key_hint: String,
    pub image_provider: AiProvider,
    pub image_base_url: String,
    pub image_model: String,
    pub image_api_key_set: bool,
    pub image_api_key_hint: String,
    pub image_aspect: String,
    pub image_resolution: String,
    pub prompt_text: String,
    pub prompt_image: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSettingsSave {
    pub text_api_key: Option<String>,
    pub text_base_url: String,
    pub text_model: String,
    pub image_api_key: Option<String>,
    #[serde(default)]
    pub image_provider: AiProvider,
    pub image_base_url: String,
    pub image_model: String,
    pub image_aspect: String,
    pub image_resolution: String,
    pub prompt_text: String,
    pub prompt_image: String,
}

/// Migrate legacy shared fields into split text/image credentials.
pub fn normalize_ai_settings(mut s: AiSettings) -> (AiSettings, bool) {
    let mut dirty = false;
    let legacy_key = s.api_key.trim().to_string();
    let legacy_base = s.base_url.trim().trim_end_matches('/').to_string();
    let migrating_text = s.text_base_url.trim().is_empty();
    let migrating_image = s.image_base_url.trim().is_empty();

    if s.text_api_key.trim().is_empty() && !legacy_key.is_empty() {
        s.text_api_key = legacy_key.clone();
        dirty = true;
    }
    if s.image_api_key.trim().is_empty() && !legacy_key.is_empty() {
        s.image_api_key = legacy_key;
        dirty = true;
    }
    if migrating_text {
        s.text_base_url = if legacy_base.is_empty() {
            DEFAULT_BASE_URL.into()
        } else {
            legacy_base.clone()
        };
        dirty = true;
    }
    if migrating_image {
        s.image_base_url = if legacy_base.is_empty() {
            DEFAULT_BASE_URL.into()
        } else {
            legacy_base
        };
        s.image_provider = s.provider;
        dirty = true;
    }
    (s, dirty)
}

fn ai_settings_path() -> Result<PathBuf> {
    Ok(library::root_dir()?.join("ai.json"))
}

pub fn load_ai_settings() -> Result<AiSettings> {
    library::ensure_library()?;
    let path = ai_settings_path()?;
    if !path.exists() {
        return Ok(AiSettings::default());
    }
    let raw = fs::read_to_string(&path).unwrap_or_else(|_| "{}".into());
    let settings: AiSettings = serde_json::from_str(&raw).unwrap_or_default();
    let (mut settings, migrated) = normalize_ai_settings(settings);
    // Repair prompts corrupted by non-UTF8 editors (contain U+FFFD)
    let mut healed = migrated;
    if settings.prompt_text.contains('\u{FFFD}') || settings.prompt_text.trim().is_empty() {
        settings.prompt_text = DEFAULT_PROMPT_TEXT.into();
        healed = true;
    }
    if settings.prompt_image.contains('\u{FFFD}') || settings.prompt_image.trim().is_empty() {
        settings.prompt_image = DEFAULT_PROMPT_IMAGE.into();
        healed = true;
    }
    if healed {
        let _ = save_ai_settings(&settings);
    }
    Ok(settings)
}

pub fn save_ai_settings(settings: &AiSettings) -> Result<()> {
    library::ensure_library()?;
    let path = ai_settings_path()?;
    let raw = serde_json::to_string_pretty(settings)?;
    fs::write(&path, raw)?;
    // Best-effort: keep API keys owner-readable only on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(&path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = fs::set_permissions(&path, perms);
        }
    }
    Ok(())
}

pub fn get_ai_settings_public() -> Result<AiSettingsPublic> {
    let s = load_ai_settings()?;
    let text_key = effective_text_key(&s);
    let image_key = effective_image_key(&s);
    let image_fallback_base = match s.image_provider {
        AiProvider::Openai => OPENAI_DEFAULT_BASE_URL,
        AiProvider::Grsai => DEFAULT_BASE_URL,
    };
    let image_fallback_model = match s.image_provider {
        AiProvider::Openai => OPENAI_DEFAULT_IMAGE_MODEL,
        AiProvider::Grsai => DEFAULT_IMAGE_MODEL,
    };
    Ok(AiSettingsPublic {
        text_base_url: {
            let b = s.text_base_url.trim().trim_end_matches('/');
            if b.is_empty() {
                DEFAULT_BASE_URL.into()
            } else {
                b.to_string()
            }
        },
        text_model: if s.text_model.trim().is_empty() {
            DEFAULT_TEXT_MODEL.into()
        } else {
            s.text_model
        },
        text_api_key_set: !text_key.is_empty(),
        text_api_key_hint: key_hint(&text_key),
        image_provider: s.image_provider,
        image_base_url: {
            let b = s.image_base_url.trim().trim_end_matches('/');
            if b.is_empty() {
                image_fallback_base.into()
            } else {
                b.to_string()
            }
        },
        image_model: if s.image_model.trim().is_empty() {
            image_fallback_model.into()
        } else {
            s.image_model
        },
        image_api_key_set: !image_key.is_empty(),
        image_api_key_hint: key_hint(&image_key),
        image_aspect: if s.image_aspect.trim().is_empty() {
            DEFAULT_IMAGE_ASPECT.into()
        } else {
            s.image_aspect
        },
        image_resolution: if s.image_resolution.trim().is_empty() {
            DEFAULT_IMAGE_RESOLUTION.into()
        } else {
            s.image_resolution
        },
        prompt_text: if s.prompt_text.trim().is_empty() {
            DEFAULT_PROMPT_TEXT.into()
        } else {
            s.prompt_text
        },
        prompt_image: if s.prompt_image.trim().is_empty() {
            DEFAULT_PROMPT_IMAGE.into()
        } else {
            s.prompt_image
        },
    })
}

pub fn update_ai_settings(input: AiSettingsSave) -> Result<AiSettingsPublic> {
    let mut current = load_ai_settings()?;
    if let Some(key) = input.text_api_key {
        let trimmed = key.trim().to_string();
        if !trimmed.is_empty() {
            current.text_api_key = trimmed;
        }
    }
    if let Some(key) = input.image_api_key {
        let trimmed = key.trim().to_string();
        if !trimmed.is_empty() {
            current.image_api_key = trimmed;
        }
    }
    current.text_base_url = if input.text_base_url.trim().is_empty() {
        DEFAULT_BASE_URL.into()
    } else {
        input.text_base_url.trim().trim_end_matches('/').to_string()
    };
    current.text_model = if input.text_model.trim().is_empty() {
        DEFAULT_TEXT_MODEL.into()
    } else {
        input.text_model.trim().to_string()
    };
    current.image_provider = input.image_provider;
    let image_fallback_base = match current.image_provider {
        AiProvider::Openai => OPENAI_DEFAULT_BASE_URL,
        AiProvider::Grsai => DEFAULT_BASE_URL,
    };
    let image_fallback_model = match current.image_provider {
        AiProvider::Openai => OPENAI_DEFAULT_IMAGE_MODEL,
        AiProvider::Grsai => DEFAULT_IMAGE_MODEL,
    };
    current.image_base_url = if input.image_base_url.trim().is_empty() {
        image_fallback_base.into()
    } else {
        input.image_base_url.trim().trim_end_matches('/').to_string()
    };
    current.image_model = if input.image_model.trim().is_empty() {
        image_fallback_model.into()
    } else {
        input.image_model.trim().to_string()
    };
    current.image_aspect = if input.image_aspect.trim().is_empty() {
        DEFAULT_IMAGE_ASPECT.into()
    } else {
        input.image_aspect.trim().to_string()
    };
    current.image_resolution = if input.image_resolution.trim().is_empty() {
        DEFAULT_IMAGE_RESOLUTION.into()
    } else {
        input.image_resolution.trim().to_uppercase()
    };
    current.prompt_text = if input.prompt_text.trim().is_empty() {
        DEFAULT_PROMPT_TEXT.into()
    } else {
        input.prompt_text
    };
    current.prompt_image = if input.prompt_image.trim().is_empty() {
        DEFAULT_PROMPT_IMAGE.into()
    } else {
        input.prompt_image
    };
    // Keep legacy mirrors in sync for older backups / tools.
    current.provider = current.image_provider;
    current.base_url = current.text_base_url.clone();
    if current.api_key.trim().is_empty() {
        current.api_key = current.text_api_key.clone();
    }
    save_ai_settings(&current)?;
    get_ai_settings_public()
}

pub fn reset_ai_prompts() -> Result<AiSettingsPublic> {
    let mut current = load_ai_settings()?;
    current.prompt_text = DEFAULT_PROMPT_TEXT.into();
    current.prompt_image = DEFAULT_PROMPT_IMAGE.into();
    save_ai_settings(&current)?;
    get_ai_settings_public()
}

fn effective_text_key(settings: &AiSettings) -> String {
    let k = settings.text_api_key.trim();
    if !k.is_empty() {
        return k.to_string();
    }
    settings.api_key.trim().to_string()
}

fn effective_image_key(settings: &AiSettings) -> String {
    let k = settings.image_api_key.trim();
    if !k.is_empty() {
        return k.to_string();
    }
    let legacy = settings.api_key.trim();
    if !legacy.is_empty() {
        return legacy.to_string();
    }
    // Fall back to text key so one-key setups still work for covers.
    settings.text_api_key.trim().to_string()
}

fn require_text_key(settings: &AiSettings) -> Result<String> {
    let key = effective_text_key(settings);
    if key.is_empty() {
        bail!("请先在设置中配置「文字」API Key");
    }
    Ok(key)
}

fn require_image_key(settings: &AiSettings) -> Result<String> {
    let key = effective_image_key(settings);
    if key.is_empty() {
        bail!("请先在设置中配置「图像」API Key");
    }
    Ok(key)
}

fn text_base_url(settings: &AiSettings) -> String {
    let b = settings.text_base_url.trim().trim_end_matches('/');
    if b.is_empty() {
        let legacy = settings.base_url.trim().trim_end_matches('/');
        if legacy.is_empty() {
            DEFAULT_BASE_URL.into()
        } else {
            legacy.to_string()
        }
    } else {
        b.to_string()
    }
}

fn image_base_url(settings: &AiSettings) -> String {
    let b = settings.image_base_url.trim().trim_end_matches('/');
    if b.is_empty() {
        let legacy = settings.base_url.trim().trim_end_matches('/');
        if legacy.is_empty() {
            match settings.image_provider {
                AiProvider::Openai => OPENAI_DEFAULT_BASE_URL.into(),
                AiProvider::Grsai => DEFAULT_BASE_URL.into(),
            }
        } else {
            legacy.to_string()
        }
    } else {
        b.to_string()
    }
}

fn http_agent(read_secs: u64) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(read_secs))
        .timeout_write(Duration::from_secs(30))
        .timeout(Duration::from_secs(read_secs + 20))
        .build()
}

fn truncate_err(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn parse_json_or_sse(text: &str) -> Result<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        bail!("空响应");
    }

    // Non-stream JSON
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Ok(v);
    }

    // Stream / SSE: assemble deltas into a synthetic OpenAI-style payload
    if trimmed.contains("data:") {
        let mut last_full: Option<Value> = None;
        let mut delta_text = String::new();
        for line in trimmed.lines() {
            let Some(rest) = line.strip_prefix("data:") else {
                continue;
            };
            let payload = rest.trim();
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(payload) else {
                continue;
            };
            if let Some(piece) = extract_delta_text(&v) {
                delta_text.push_str(&piece);
            }
            last_full = Some(v);
        }
        if !delta_text.trim().is_empty() {
            return Ok(json!({
                "choices": [{
                    "message": { "role": "assistant", "content": delta_text }
                }]
            }));
        }
        if let Some(v) = last_full {
            return Ok(v);
        }
    }

    bail!("响应不是 JSON：{}", truncate_err(trimmed, 400))
}

fn extract_delta_text(v: &Value) -> Option<String> {
    if let Some(s) = v
        .pointer("/choices/0/delta/content")
        .and_then(|c| content_to_string(c))
    {
        return Some(s);
    }
    content_to_string(v.pointer("/choices/0/message/content").unwrap_or(&Value::Null))
}

fn content_to_string(content: &Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        let t = s.trim();
        return if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        };
    }
    if let Some(arr) = content.as_array() {
        let mut out = String::new();
        for part in arr {
            if let Some(s) = part.as_str() {
                out.push_str(s);
            } else if let Some(s) = part.get("text").and_then(|t| t.as_str()) {
                out.push_str(s);
            } else if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(s) = part.get("text").and_then(|t| t.as_str()) {
                    out.push_str(s);
                }
            }
        }
        let t = out.trim();
        return if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        };
    }
    None
}

fn api_error_message(resp: &Value) -> Option<String> {
    if let Some(err) = resp.get("error") {
        if let Some(msg) = err.get("message").and_then(|m| m.as_str()) {
            return Some(msg.to_string());
        }
        return Some(err.to_string());
    }
    if let Some(msg) = resp.get("msg").and_then(|m| m.as_str()) {
        if resp
            .get("code")
            .and_then(|c| c.as_i64())
            .is_some_and(|c| c != 0 && c != 200)
        {
            return Some(msg.to_string());
        }
    }
    None
}

fn post_json(url: &str, key: &str, body: &Value, read_secs: u64) -> Result<Value> {
    let agent = http_agent(read_secs);
    let result = agent
        .post(url)
        .set("Authorization", &format!("Bearer {key}"))
        .set("Content-Type", "application/json")
        .send_json(body.clone());
    let resp = match result {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            bail!("HTTP {code}: {}", truncate_err(&text, 800));
        }
        Err(ureq::Error::Transport(t)) => {
            bail!("网络超时或连接失败：{t}（请检查 API Key / 网络 / Base URL）");
        }
    };
    let text = resp.into_string().context("读取响应失败")?;
    let value = parse_json_or_sse(&text)?;
    if let Some(msg) = api_error_message(&value) {
        bail!("{msg}");
    }
    Ok(value)
}

fn chat_completion(settings: &AiSettings, system: &str, user: &str) -> Result<String> {
    let key = require_text_key(settings)?;
    let base = text_base_url(settings);
    let model = if settings.text_model.trim().is_empty() {
        DEFAULT_TEXT_MODEL
    } else {
        settings.text_model.trim()
    };
    let url = format!("{base}/chat/completions");
    // 多数兼容网关（含 GrsAI）要求显式 stream:false，否则可能走 SSE 挂起
    let body = json!({
        "model": model,
        "stream": false,
        "temperature": 0.4,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ]
    });
    let resp = post_json(&url, &key, &body, 90)?;
    let content = resp
        .pointer("/choices/0/message/content")
        .and_then(content_to_string)
        .or_else(|| resp.pointer("/choices/0/text").and_then(content_to_string))
        .or_else(|| resp.get("content").and_then(content_to_string))
        .unwrap_or_default();
    if content.is_empty() {
        bail!(
            "模型返回空内容：{}",
            truncate_err(&resp.to_string(), 300)
        );
    }
    Ok(content)
}

fn normalize_resolution(raw: &str) -> &'static str {
    match raw.trim().to_uppercase().as_str() {
        "1K" | "1" => "1K",
        "2K" | "2" => "2K",
        _ => "4K",
    }
}

/// GrsAI GPT Image 像素尺寸（1K / 2K / 4K），宽高均为 16 的倍数。
fn aspect_to_size(aspect: &str, resolution: &str) -> &'static str {
    let res = normalize_resolution(resolution);
    match (aspect.trim(), res) {
        ("1:1", "1K") => "1024x1024",
        ("1:1", "2K") => "2048x2048",
        ("1:1", _) => "2880x2880",
        ("9:16", "1K") => "720x1280",
        ("9:16", "2K") => "1152x2048",
        ("9:16", _) => "2160x3840",
        ("4:3", "1K") => "1152x864",
        ("4:3", "2K") => "2304x1728",
        ("4:3", _) => "3264x2448",
        ("3:4", "1K") => "864x1152",
        ("3:4", "2K") => "1728x2304",
        ("3:4", _) => "2448x3264",
        ("3:2", "1K") => "1536x1024",
        ("3:2", "2K") => "2048x1360",
        ("3:2", _) => "3504x2336",
        ("16:9", "1K") => "1280x720",
        ("16:9", "2K") => "2048x1152",
        ("16:9", _) => "3840x2160",
        (_, "1K") => "1280x720",
        (_, "2K") => "2048x1152",
        _ => "3840x2160",
    }
}

/// OpenAI / 兼容网关常见尺寸（DALL·E 3 或 gpt-image-1）。
fn aspect_to_openai_size(model: &str, aspect: &str) -> &'static str {
    let a = aspect.trim();
    let gpt_image = model.to_ascii_lowercase().contains("gpt-image");
    if gpt_image {
        match a {
            "1:1" => "1024x1024",
            "9:16" | "3:4" | "2:3" => "1024x1536",
            _ => "1536x1024",
        }
    } else {
        // dall-e-3 / 多数兼容代理
        match a {
            "1:1" => "1024x1024",
            "9:16" | "3:4" | "2:3" => "1024x1792",
            _ => "1792x1024",
        }
    }
}

fn openai_images_body(model: &str, prompt: &str, size: &str) -> Value {
    let mut body = json!({
        "model": model,
        "prompt": prompt,
        "size": size,
        "n": 1,
    });
    let lower = model.to_ascii_lowercase();
    if lower.contains("dall-e-3") {
        body["quality"] = json!("standard");
    }
    body
}

fn write_image_bytes(dest: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(dest, bytes)?;
    Ok(())
}

fn poll_generate_result(settings: &AiSettings, task_id: &str) -> Result<Value> {
    let key = require_image_key(settings)?;
    let base = image_base_url(settings);
    let url = format!("{base}/api/result?id={task_id}");
    let agent = http_agent(30);
    // 4K 出图可能较慢：最多约 3 分钟
    for i in 0..90 {
        ensure_not_cancelled()?;
        thread::sleep(Duration::from_secs(if i < 3 { 1 } else { 2 }));
        ensure_not_cancelled()?;
        let result = agent
            .get(&url)
            .set("Authorization", &format!("Bearer {key}"))
            .call();
        let resp = match result {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) => {
                let text = r.into_string().unwrap_or_default();
                bail!("查询出图结果 HTTP {code}: {}", truncate_err(&text, 400));
            }
            Err(ureq::Error::Transport(t)) => {
                // 短暂网络抖动：继续轮询
                if i > 80 {
                    bail!("查询出图结果失败：{t}");
                }
                continue;
            }
        };
        let text = resp.into_string().unwrap_or_default();
        let value = parse_json_or_sse(&text)?;
        let status = value
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("");
        match status {
            "succeeded" => return Ok(value),
            "failed" | "violation" => {
                bail!(
                    "出图失败：{}",
                    value
                        .get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or(status)
                );
            }
            "running" | "" => continue,
            other => {
                // 未知状态但已有 results 则当作成功
                if value.pointer("/results/0/url").is_some() {
                    return Ok(value);
                }
                bail!("出图状态异常：{other}");
            }
        }
    }
    bail!("出图超时（等待结果超过约 3 分钟）");
}

fn extract_image_item(resp: &Value) -> Value {
    resp.pointer("/data/0")
        .or_else(|| resp.pointer("/results/0"))
        .cloned()
        .or_else(|| {
            resp.get("data")
                .and_then(|d| d.as_array())
                .and_then(|a| a.first())
                .cloned()
        })
        .or_else(|| {
            resp.get("results")
                .and_then(|d| d.as_array())
                .and_then(|a| a.first())
                .cloned()
        })
        .unwrap_or_else(|| resp.clone())
}

fn save_image_from_response(resp: &Value, dest: &Path) -> Result<()> {
    let item = extract_image_item(resp);

    if let Some(b64) = item
        .get("b64_json")
        .or_else(|| item.get("b64"))
        .and_then(|v| v.as_str())
    {
        use base64::Engine;
        let raw = b64
            .strip_prefix("data:image/png;base64,")
            .or_else(|| b64.strip_prefix("data:image/jpeg;base64,"))
            .unwrap_or(b64);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw)
            .context("解码图片失败")?;
        write_image_bytes(dest, &bytes)?;
        return Ok(());
    }

    let image_url = item
        .get("url")
        .or_else(|| item.get("imageUrl"))
        .or_else(|| item.get("image_url"))
        .and_then(|v| v.as_str())
        .or_else(|| item.as_str())
        .with_context(|| {
            format!(
                "出图响应中没有图片数据：{}",
                truncate_err(&item.to_string(), 300)
            )
        })?;

    let agent = http_agent(90);
    let dl = agent
        .get(image_url)
        .call()
        .map_err(|e| anyhow::anyhow!("下载图片失败：{e}"))?;
    let mut bytes = Vec::new();
    dl.into_reader()
        .take(40_000_000)
        .read_to_end(&mut bytes)
        .context("读取图片失败")?;
    if bytes.is_empty() {
        bail!("下载到的图片为空");
    }
    write_image_bytes(dest, &bytes)?;
    Ok(())
}

fn generate_image_file(
    settings: &AiSettings,
    prompt: &str,
    dest: &Path,
    app: Option<&AppHandle>,
    skill_id: &str,
) -> Result<()> {
    let key = require_image_key(settings)?;
    let base = image_base_url(settings);
    let model = settings.image_model.trim();
    let aspect = if settings.image_aspect.trim().is_empty() {
        DEFAULT_IMAGE_ASPECT
    } else {
        settings.image_aspect.trim()
    };
    let resolution = if settings.image_resolution.trim().is_empty() {
        DEFAULT_IMAGE_RESOLUTION
    } else {
        settings.image_resolution.trim()
    };
    // 过长 prompt 容易导致出图失败
    let prompt: String = prompt.chars().take(2200).collect();

    emit_progress(app, "cover", skill_id, "image", 55, "正在提交出图任务…");

    let (url, body, read_secs, allow_grsai_poll) = match settings.image_provider {
        AiProvider::Openai => {
            let size = aspect_to_openai_size(model, aspect);
            (
                format!("{base}/images/generations"),
                openai_images_body(model, &prompt, size),
                150u64,
                false,
            )
        }
        AiProvider::Grsai => {
            let size = aspect_to_size(aspect, resolution);
            let res_label = normalize_resolution(resolution);
            // gpt-image / nano-banana：异步提交 + 轮询，避免长连接挂死
            if model.starts_with("nano-banana") {
                (
                    format!("{base}/api/generate"),
                    json!({
                        "model": model,
                        "prompt": prompt,
                        "images": [],
                        "aspectRatio": aspect,
                        "imageSize": res_label,
                        "replyType": "async"
                    }),
                    60u64,
                    true,
                )
            } else if model.starts_with("gpt-image") {
                (
                    format!("{base}/api/generate"),
                    json!({
                        "model": model,
                        "prompt": prompt,
                        "images": [],
                        "aspectRatio": size,
                        "quality": "auto",
                        "replyType": "async"
                    }),
                    60u64,
                    true,
                )
            } else {
                (
                    format!("{base}/images/generations"),
                    json!({
                        "model": model,
                        "prompt": prompt,
                        "size": size,
                        "n": 1
                    }),
                    120u64,
                    false,
                )
            }
        }
    };

    let mut resp = post_json(&url, &key, &body, read_secs)?;
    if let Some(code) = resp.get("code").and_then(|c| c.as_i64()) {
        if code != 0 && code != 200 {
            bail!(
                "出图失败：{}",
                resp.get("msg").unwrap_or(&resp).to_string()
            );
        }
    }

    let status = resp.get("status").and_then(|s| s.as_str()).unwrap_or("");
    if matches!(status, "failed" | "violation") {
        bail!(
            "出图失败：{}",
            resp.get("error")
                .and_then(|e| e.as_str())
                .unwrap_or(status)
        );
    }

    // GrsAI 异步或尚未完成：轮询结果（OpenAI 兼容路径不同步轮询）
    if allow_grsai_poll {
        let needs_poll = status == "running"
            || (resp.pointer("/results/0/url").is_none()
                && resp.pointer("/data/0").is_none()
                && resp.get("id").and_then(|v| v.as_str()).is_some());
        if needs_poll {
            let task_id = resp
                .get("id")
                .and_then(|v| v.as_str())
                .context("出图任务缺少 id，无法查询进度")?;
            emit_progress(
                app,
                "cover",
                skill_id,
                "image",
                65,
                &format!("出图中（任务 {task_id}）…"),
            );
            resp = poll_generate_result(settings, task_id)?;
        }
    }

    emit_progress(app, "cover", skill_id, "download", 85, "正在下载并压缩封面…");
    save_image_from_response(&resp, dest)?;
    Ok(())
}

/// Extract compact skill context for LLM (name/description/leading body).
pub fn skill_excerpt(skill_id: &str) -> Result<String> {
    let md = library::read_skill_markdown(skill_id)?;
    let mut name = skill_id.to_string();
    let mut description = String::new();
    let mut in_fm = false;
    let mut body_lines: Vec<String> = Vec::new();
    let mut past_fm = false;
    let mut saw_fm = false;

    for line in md.lines() {
        let trimmed = line.trim();
        if !saw_fm && trimmed == "---" {
            in_fm = true;
            saw_fm = true;
            continue;
        }
        if in_fm {
            if trimmed == "---" {
                in_fm = false;
                past_fm = true;
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("name:") {
                let v = rest.trim().trim_matches('"').trim_matches('\'').trim();
                if !v.is_empty() {
                    name = v.to_string();
                }
            } else if let Some(rest) = trimmed.strip_prefix("description:") {
                let v = rest.trim().trim_matches('"').trim_matches('\'').trim();
                if !v.is_empty() {
                    description = v.to_string();
                }
            }
            continue;
        }
        if saw_fm && !past_fm {
            continue;
        }
        if trimmed.is_empty() && body_lines.is_empty() {
            continue;
        }
        body_lines.push(line.to_string());
        if body_lines.len() >= 24 {
            break;
        }
    }

    if description.is_empty() && !saw_fm {
        // no frontmatter: take first non-empty paragraph-ish lines as body
        body_lines.clear();
        for line in md.lines().take(30) {
            body_lines.push(line.to_string());
        }
    }

    let body = body_lines.join("\n");
    let body = if body.chars().count() > 1800 {
        let truncated: String = body.chars().take(1800).collect();
        format!("{truncated}\n…(truncated)")
    } else {
        body
    };

    Ok(format!(
        "Skill ID: {skill_id}\nName: {name}\nDescription: {description}\n\nSKILL.md excerpt:\n{body}"
    ))
}

fn clean_text_output(raw: &str) -> String {
    let mut t = raw.trim().to_string();
    for prefix in ["好的", "摘要如下", "概述：", "概述:", "简介：", "简介:"] {
        if t.starts_with(prefix) {
            t = t[prefix.len()..].trim().trim_start_matches([':', '：']).trim().to_string();
        }
    }
    t.trim_matches(|c| c == '"' || c == '“' || c == '”').trim().to_string()
}

fn clean_image_prompt(raw: &str) -> String {
    let mut t = raw.trim().to_string();
    if let Some(rest) = t.strip_prefix("[Prompt]") {
        t = rest.trim().trim_start_matches('=').trim().to_string();
    }
    if let Some(rest) = t.strip_prefix("Prompt:") {
        t = rest.trim().to_string();
    }
    // 去掉 markdown 代码围栏
    if t.starts_with("```") {
        t = t.trim_start_matches('`').to_string();
        if let Some(pos) = t.find('\n') {
            t = t[pos + 1..].to_string();
        }
        if let Some(pos) = t.rfind("```") {
            t = t[..pos].to_string();
        }
    }
    t.trim_matches(|c| c == '"' || c == '`').trim().to_string()
}

pub fn test_ai_connection() -> Result<String> {
    let settings = load_ai_settings()?;
    let raw = chat_completion(
        &settings,
        "You are a connectivity probe.",
        "Reply with exactly: OK",
    )?;
    let t = raw.trim().to_string();
    if t.is_empty() {
        bail!("连接成功但模型返回空内容");
    }
    Ok(format!(
        "文字连接成功（{}）：{}",
        settings.text_model,
        truncate_err(&t, 80)
    ))
}

pub fn generate_skill_description(
    skill_id: &str,
    app: Option<&AppHandle>,
) -> Result<(String, Vec<SkillCard>)> {
    // 不在此处 clear：并发任务共享取消标志，由前端在开跑前 clear
    ensure_not_cancelled()?;
    let settings = load_ai_settings()?;
    emit_progress(app, "zh", skill_id, "chat", 20, "正在生成中文简介…");
    let excerpt = skill_excerpt(skill_id).map_err(|e| {
        write_last_error(&e.to_string());
        e
    })?;
    ensure_not_cancelled()?;
    let user = format!(
        "请根据以下 skill 摘要，按系统要求直接输出 40-70 字中文概述：\n\n{excerpt}"
    );
    let raw = chat_completion(&settings, &settings.prompt_text, &user).map_err(|e| {
        let msg = format!("生成简介失败（文字通道）：{e}");
        write_last_error(&msg);
        anyhow::anyhow!(msg)
    })?;
    ensure_not_cancelled()?;
    let text = clean_text_output(&raw);
    if text.is_empty() {
        let msg = "生成结果为空";
        write_last_error(msg);
        bail!("{msg}");
    }
    emit_progress(app, "zh", skill_id, "save", 90, "正在写入简介…");
    let list = library::set_skill_description_zh(skill_id, text.clone())?;
    emit_progress(app, "zh", skill_id, "done", 100, "简介已生成");
    Ok((text, list))
}

pub fn generate_skill_cover(skill_id: &str, app: Option<&AppHandle>) -> Result<Vec<SkillCard>> {
    ensure_not_cancelled()?;
    let settings = load_ai_settings()?;
    emit_progress(app, "cover", skill_id, "prompt", 15, "正在生成封面提示词…");
    let excerpt = skill_excerpt(skill_id).map_err(|e| {
        write_last_error(&e.to_string());
        e
    })?;
    ensure_not_cancelled()?;
    let user = format!(
        "请根据以下 skill 摘要，按系统要求直接输出英文 Image Prompt（不要解释）：\n\n{excerpt}"
    );
    let prompt_raw = chat_completion(&settings, &settings.prompt_image, &user).map_err(|e| {
        let msg = format!("生成封面提示词失败（文字通道）：{e}");
        write_last_error(&msg);
        anyhow::anyhow!(msg)
    })?;
    ensure_not_cancelled()?;
    let image_prompt = clean_image_prompt(&prompt_raw);
    if image_prompt.is_empty() {
        let msg = "出图提示词为空";
        write_last_error(msg);
        bail!("{msg}");
    }

    library::ensure_library()?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("skill-panel-cover-{skill_id}-{stamp}.png"));
    generate_image_file(&settings, &image_prompt, &tmp, app, skill_id).map_err(|e| {
        write_last_error(&e.to_string());
        e
    })?;
    ensure_not_cancelled()?;
    emit_progress(app, "cover", skill_id, "save", 95, "正在保存封面…");
    let list = library::set_skill_cover(skill_id, &tmp.to_string_lossy())?;
    let _ = fs::remove_file(&tmp);
    emit_progress(app, "cover", skill_id, "done", 100, "封面已生成");
    Ok(list)
}

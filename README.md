# Skill Panel

轻量 Skill 管理面板。

## 能力（v0.1）

- 托盘 + 全局快捷键唤出（Win: `Ctrl+Shift+S` / Mac: `Cmd+Shift+S`），窗口置顶
- 本地技能库卡片：简介、标签、置顶
- **应用**：复制部署到 Cursor / Codex 全局 skills，并粘贴 `$文件夹名`
- ChatGPT：仅复制/粘贴 `$name`（优先 SKILL.md frontmatter `name:`，否则文件夹名；不部署）
- 安装：本地目录 / Git / skills.sh 风格源

## 数据目录

```
~/.skill-panel/
  skills/     # 中央库
  meta.json   # 标签、置顶、Agent 路径覆盖
```

## 开发

### Windows

双击 `start.bat`，或：

```bash
npm install
npm run tauri dev
```

### macOS

先安装依赖环境：

1. [Node.js](https://nodejs.org/)
2. Rust：`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
3. Xcode CLT：`xcode-select --install`

然后：

```bash
chmod +x start.sh
./start.sh
```

或手动：

```bash
npm install
npm run tauri dev
```

全局唤出快捷键：Windows 为 `Ctrl+Shift+S`，macOS 为 `Cmd+Shift+S`。  
首次自动粘贴时，系统可能要求授予「辅助功能」权限。

## 一键打包 / 安装

### Windows（本机可直接打出安装包）

**给用户安装（推荐）：** 双击 `install-portable.bat`  
或使用 `release/Skill Panel_0.1.0_x64-setup.exe`（已内置离线 WebView2，约 210MB）。

若弹出「Windows 已保护你的电脑」→ **更多信息** → **仍要运行**（未代码签名时的正常提示）。

重新打包：

```bat
build-win.bat
```

### macOS（必须在 Mac 上构建）

```bash
chmod +x build-mac.sh
./build-mac.sh
```

生成：`.dmg` / `.app`，打开 DMG 拖到「应用程序」即可。  
（无法在 Windows 上交叉编译出可用的 Mac 安装包。）

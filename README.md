# Skill Panel

轻量 Skill 管理面板（独立于 Skills Manager）。

## 能力（v0.1）

- 托盘 + `Ctrl+Shift+S` 唤出，窗口置顶，失焦收起
- 本地技能库卡片：简介、标签、置顶
- **应用**：复制部署到 Cursor / Codex 全局 skills，并粘贴 `$文件夹名`
- ChatGPT：仅复制/粘贴 `$name`
- 安装：本地目录 / Git / skills.sh 风格源

## 数据目录

```
~/.skill-panel/
  skills/     # 中央库
  meta.json   # 标签、置顶、Agent 路径覆盖
```

## 开发

```bash
npm install
npm run tauri dev
```

## 与 Skills Manager 的关系

全新独立项目与独立库目录，不共用 `~/.skills-manager`。

# 挑染AI工作台 · Tiaoran Workbench

一个本地桌面工作台，把「出图提示词 → 出片提示词 → 视频生成」串成一条流水线。
内置 Node 服务，不依赖浏览器插件；图片与视频的提示词分开管理。

> Desktop workbench for AI prompt engineering and MiniMax H3 video generation through ComfyUI.

[![release](https://img.shields.io/github/v/release/zqa1218/-AI-?label=download&color=4cc9f0)](https://github.com/zqa1218/-AI-/releases/latest)

**直接下载：[TiaoranWorkbench-1.0.0.exe](https://github.com/zqa1218/-AI-/releases/download/v1.0.0/TiaoranWorkbench-1.0.0.exe)**（约 71 MB，免安装单文件）

---

## 功能

### 一、图片提示词（复刻修图工作流）

- **① 底图分析**：主体 / 光线 / 材质 / 构图 / 色调 + 可改进项
- **② 参考图拆解**：可迁移项与不建议照搬的点
- **③ 方向建议**：按线路（原图精修 / 产品精修 / 角色设定 / Cosplay）生成 3 个差异化方向
- **④ 细化**：用途 / 规格 / 约束
- **⑤ 生成提示词**：中文提示词 + 英文 Midjourney 提示词 + 参数行 + 提交前检查
- **AI 优化**：先写要求，再按要求改写（保留主体，可撤销）

### 二、视频提示词（两种模式）

| 模式 | 时长 | 写法 | 适用 |
|---|---|---|---|
| 🎥 运镜 10s | 10 秒 | 3–4 个节拍 + 一条完整运镜路径 | 人物出场、场景展示 |
| 🫧 Live2D 5s 微动 | 5 秒 | 呼吸/眨眼/发丝/衣摆/重心微动，机位锁死 | 动态立绘、可循环素材 |

- **首尾同帧循环**：Live2D 模式把同一张图同时作为首帧与尾帧，输出可无缝循环（实测首尾帧差异 <1%）
- **按要求优化**：先写要求再改写视频提示词
- **预设资产**：分镜骨架、推荐运镜、负面词可自行扩展（`app/resources/presets/`）
- **出片**：MiniMax H3 Max / 768P，自动归档提示词与参考图到项目目录

### 三、项目管理

每个项目自动生成 `00_提示词 / 01_参考图 / 02_工作流 / 03_成片 / 04_素材`，
提交时自动写入提示词（含历史版本）、复制参考图、记录生成费用。

---

## 环境要求

| 依赖 | 说明 |
|---|---|
| Windows 10/11 | 主要目标平台 |
| **ComfyUI** | 需在 `127.0.0.1:8188` 运行，并具备 MiniMax H3 节点（内置 partner 节点或 [ComfyUI-MiniMax-H3-API](https://github.com/magicwang1111/ComfyUI-MiniMax-H3-API)） |
| **MiniMax API Key** | 国内站 `api.minimaxi.com`，用于视觉分析、提示词生成和视频生成 |

> 没有 ComfyUI 时，提示词相关功能仍可正常使用，只有「生成视频」不可用。

---

## 快速开始

### 方式一：下载 exe（推荐）

1. 下载 [TiaoranWorkbench-1.0.0.exe](https://github.com/zqa1218/-AI-/releases/download/v1.0.0/TiaoranWorkbench-1.0.0.exe)
2. 双击运行（首次启动会在「文档/TiaoranAI」建好数据目录）
3. 界面右上「↓ 更新工作流」会从本仓库拉取最新 ComfyUI 工作流

> 若 Windows 提示未知发布者，请选择「更多信息 → 仍要运行」（未做代码签名）。

### 方式二：源码运行

```bash
git clone <your-repo-url>
cd tiaoran-workbench
npm install
npm start
```

或下载 Release 中的 `TiaoranWorkbench-*.exe` 直接运行。

首次启动会自动在 **「文档/TiaoranAI」** 创建数据目录并铺好内置预设、词库与工作流模板。

### 工作流自动更新

界面右上「↓ 更新工作流」→ 从本仓库 `app/resources/workflows/` 拉取 JSON，
写入 `<数据目录>/项目组/_模板/02_工作流` 与 `<数据目录>/工作流`。

想换源（自己的 fork 或分支）：

```bash
set TIAORAN_WF_BASE=https://raw.githubusercontent.com/<owner>/<repo>/main/app/resources/workflows/
```

---

## 配置

配置文件：`%APPDATA%\TiaoranWorkbench\config.json`

```json
{
  "aiDir": "D:\\TiaoranAI",
  "galleryDir": "D:\\照片\\素材",
  "apiKey": "sk-..."
}
```

| 键 | 说明 |
|---|---|
| `aiDir` | 数据根目录，默认「文档/TiaoranAI」，也可用环境变量 `TIAORAN_HOME` |
| `galleryDir` | 图库目录（界面里也可切换） |
| `apiKey` | MiniMax Key；未设置时会读取 `<aiDir>/配置/minimax.local.json` |

**密钥不要提交到仓库。** `.gitignore` 已忽略本地配置。

| 环境变量 | 说明 |
|---|---|
| `TIAORAN_HOME` | 覆盖数据根目录 |
| `TIAORAN_SCALE` | 界面缩放，默认 `1.5`（高 DPI 适配）；`0` 表示跟随系统 |

---

## 数据目录结构

```
TiaoranAI/
├─ 提示词组/            词库（一行一条）+ _预设/（分镜资产）
├─ 项目组/              每个项目一个目录
│  └─ 20260101_项目名/
│     ├─ 00_提示词/     提示词.md（最新）+ 提示词_时间戳.md（历史）+ 生成记录.md
│     ├─ 01_参考图/     提交时自动复制的参考图
│     ├─ 02_工作流/     ComfyUI 工作流模板
│     ├─ 03_成片/       生成的视频
│     └─ 04_素材/
├─ 出图/                图库与成片临时目录
└─ 配置/                minimax.local.json（可选）
```

---

## 目录结构（源码）

```
tiaoran-workbench/
├─ app/
│  ├─ main.js            Electron 主进程（窗口、菜单、DPI 适配）
│  ├─ server.js          本地 HTTP 服务 + MiniMax/ComfyUI 调用
│  ├─ web/               前端（原生 HTML/CSS/JS，无框架）
│  ├─ assets/            图标
│  └─ resources/         内置预设 / 词库 / 工作流模板
└─ package.json
```

## 技术要点

- **无框架前端**：单页 + 原生 JS，启动快、体积小
- **图库可切换**：支持任意目录、悬停删除（走回收站，可恢复）
- **自动保存**：提示词、参考图、项目、成片在重启后自动恢复
- **高 DPI**：200% 缩放下强制 1.5 倍缩放，避免窗口被撑出屏幕
- **媒体多根解析**：图库切换后仍能播放历史成片

---

## 打包

```bash
npm install
npm run build:win     # 生成 dist/TiaoranWorkbench-1.0.0.exe（portable）
```

> 若在无管理员权限的机器上打包失败（winCodeSign 解压需要创建符号链接），
> 可改用 `npm run build:dir` 产出免安装目录，或直接使用仓库构建产物。

---

## 免责声明

- 视频生成按秒计费，费用由 MiniMax 账户承担，请自行留意用量
- 生成内容需遵守当地法律法规与平台规范，请勿用于侵权、伪造或违规用途
- 本项目仅提供提示词工程与调用封装，不存储、不转售任何模型能力

## License

[MIT](LICENSE)
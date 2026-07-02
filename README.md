# Videohao · 图书带货视频工厂

抖音爆款 → 成片素材的一站式流水线。粘贴一条抖音分享链接（或直接粘贴口播文案），在同一个网页里自动跑完：

> 逐字稿 → 爆款分析 → 改写 → 分镜 → 导演分镜 → 批量生图 → 配音 → 字幕对齐 → 时间线合成 → 带字幕竖版成片

每一步产物都落盘、状态进数据库，前端可逐步审阅、单步重跑、单图重生成。

---

## ✨ 核心特性

- **一键成片**：链接/文案进，竖版 1080×1920 成片出（含配音、字幕、Ken Burns 运镜）。
- **导演层世界观提取**：自动从文案判定人物国籍/年代/族裔/场景，画面严格统一（美国题材不会画成中式背景）。
- **画面匹配四层策略**：优先直译文案比喻 → 造贴切隐喻 → 人物情绪行为 → 物件级合规红线，兼顾贴合度与平台合规。
- **九宫格省钱生图 + 视觉自动归位**：一次出 3×3 网格图省成本，再用多模态视觉模型把每格归位到正确镜头，解决错位问题。
- **FFmpeg 原生渲染**：秒级、无网络依赖、确定性；HyperFrames 作为兜底后端（`RENDER_BACKEND` 可切换）。
- **稳定性优先**：全局并发限流、每任务互斥锁、SQLite WAL、LLM/TTS 三层 JSON 容错、Provider 超时重试、持久化日志 + SSE 实时查看。
- **快速制作配置中心**：一页预设所有配置，后台自动跑到审阅点或全自动到成片。

---

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| 编排 / 前端 | Next.js 15 + React 19 + TypeScript |
| 数据库 | SQLite（@libsql/client + Drizzle ORM） |
| 抖音解析 | TikHub API |
| 逐字稿 ASR | StepFun 云 |
| 改写 / 分析 / 分镜 / 导演 | 通用 LLM（OpenAI 兼容，默认 DeepSeek，可切任意厂商） |
| 配音 TTS | 火山引擎（默认）/ StepFun |
| 批量生图 | gpt-image（OpenAI 兼容，可走中转） |
| 视觉归位 | 豆包 Seed 多模态（火山方舟 Ark） |
| 成片渲染 | FFmpeg 原生（主）/ HyperFrames（兜底） |

---

## 📋 环境要求

- **Node.js** ≥ 20
- **FFmpeg / ffprobe**：必装，且需支持 `libass`（字幕）、`zoompan`、`libx264`。命令行能直接调用 `ffmpeg`/`ffprobe`，或用 `FFMPEG_PATH` / `FFPROBE_PATH` 指定路径。
- 各外部服务的 API Key（见下方配置；`PIPELINE_MODE=mock` 时全部可留空）。

---

## 🚀 部署与运行

```bash
# 1. 克隆
git clone https://github.com/luyuanwu8-rgb/videohao.git
cd videohao

# 2. 装依赖
npm install

# 3. 配置密钥：复制模板并填入你自己的 Key
cp .env.example .env.local
#   - 想先零成本跑通流程：保持 PIPELINE_MODE=mock（不调任何外部 API）
#   - 想产真实成片：把 PIPELINE_MODE 改为 real，并填好下方各 Key

# 4. 初始化数据库
npm run db:generate
npm run db:migrate

# 5.（可选）mock 全链路自检，无需任何 Key
npm run pipeline:smoke

# 6. 启动
npm run dev                  # 打开 http://localhost:3000
```

> ⚠️ **不要在 dev server 运行时执行 `npm run build`** —— 会覆盖运行中的 `.next` 导致前端失效。类型检查用 `npx tsc --noEmit`。

---

## 🔑 环境变量（`.env.local`）

照着 `.env.example` 填。`PIPELINE_MODE=mock` 时全部可空；`real` 模式下按需填写：

| 变量 | 用途 | 必填(real) |
|---|---|---|
| `TIKHUB_API_KEY` | 抖音链接解析 | 用链接模式时 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 改写/分析/分镜/导演（默认 DeepSeek） | ✅ |
| `STEPFUN_API_KEY` | 逐字稿 ASR（链接模式）| 用链接模式时 |
| `VOLC_TTS_APPID` / `VOLC_TTS_TOKEN` | 火山引擎配音 | ✅（默认 TTS） |
| `GPTIMAGE_API_KEY` / `GPTIMAGE_BASE_URL` | 批量生图 | ✅ |
| `ARK_API_KEY` | 豆包 Seed 视觉归位（火山方舟） | ✅（九宫格归位） |

> 自带文案模式（直接粘文案）无需 TikHub/StepFun-ASR，跳过解析与转写。

---

## 🔄 11 步流水线（DAG）

```
extract → transcribe → viralAnalyze → rewrite → storyboard
                                                    ├─ 视觉线: assetSearch → director → imageGenerate
                                                    └─ 音频线: tts → subtitleAlign
                                                          ↓ 汇合
                                                 timelineBuild → render → final.mp4
```

调度器认依赖关系而非顺序表，视觉线/音频线可并行，任意单步可重跑。每步产物落 `data/tasks/{id}/`，状态与成本进 SQLite。

---

## 🏗️ 结构性设计

1. **DAG 调度器**（`src/lib/pipeline.ts`）—— 认依赖、支持并行支线与单步重跑；每任务互斥锁保证并发安全。
2. **Prompt 注册表**（`src/lib/prompt-defaults.ts` + `prompts_config` 表）—— 按 step×track 组织，前端可编辑，DB 优先、源码兜底。
3. **Timeline 协议**（`src/lib/timeline.ts`）—— `timeline.json` 作为渲染契约，FFmpeg / HyperFrames 后端可切换而不影响上层。
4. **Provider 抽象**（`src/lib/providers/`）—— 每个外部服务一个文件，全部 mock-able，统一超时重试。
5. **artifacts 版本化**（`src/db/schema.ts`）—— 产物带版本，可回溯对比。

---

## 🎛️ 模式开关

- `PIPELINE_MODE=mock`：不调任何外部 API，用占位产物打通整条链路（默认，适合首次自检）。
- `PIPELINE_MODE=real`：调真实接口产出成片。
- `RENDER_BACKEND=ffmpeg`（默认）或 `hyperframes`：切换渲染后端。
- `DIRECTOR_TARGET_SEC`（默认 4.5）：每张画面覆盖的目标秒数，越小画面越密。

---

## 📄 许可

本项目仅供学习与技术交流。使用各外部 API 请遵守其服务条款；生成内容请遵守发布平台规范。

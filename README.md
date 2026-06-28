# Videohao · 图书带货视频工厂

抖音爆款 → 成片素材的一站式流水线。粘贴一条抖音分享链接，在同一个网页里跑完：
逐字稿 → 爆款分析 → 改写 → 分镜 → 批量生图 / 配音 → 字幕对齐 → 合成 → 带字幕竖版成片。

## 技术栈

- **编排/前端**：Next.js 15 + TypeScript + Drizzle + SQLite
- **抖音解析**：TikHub API
- **逐字稿 / 改写**：OpenAI（Whisper + Chat）
- **TTS**：StepFun 云
- **批量生图**：gpt-image
- **成片渲染**：HyperFrames CLI

## 11 步流水线（DAG）

```
extract → transcribe → viralAnalyze → rewrite → storyboard
                                                    ├─ 视觉线: assetSearch → imageGenerate
                                                    └─ 音频线: tts → subtitleAlign
                                                          ↓ 汇合
                                                 timelineBuild → render → final.mp4
```

每步产物落 `data/tasks/{id}/`，状态进 SQLite，前端逐 step 可见、可重跑。

## 四个结构性设计

1. **DAG 调度器**（`src/lib/pipeline.ts`）— 认依赖关系，不认顺序列表，支持并行支线与单步重跑。
2. **Prompt 注册表**（`src/prompts/{step}/{track}.ts`）— 按赛道分文件，`loadPrompt("rewrite","health")` 动态加载。
3. **Timeline 协议**（`src/lib/timeline.ts`）— `timeline.json` 作为渲染契约，换 HyperFrames/Remotion/FFmpeg 不影响上层。
4. **artifacts 版本化**（`src/db/schema.ts`）— rewrite_v1/v2/v3 共存可对比；生图带 tag 落库，为素材复用库留接缝。

## 运行

```bash
cp .env.example .env.local   # 填 4 个 key；或保持 PIPELINE_MODE=mock 先跑通
npm install
npm run db:generate && npm run db:migrate
npm run pipeline:smoke       # 端到端 mock 验证（无需任何 key）
npm run dev                  # http://localhost:3000
```

## 模式开关

- `PIPELINE_MODE=mock`：不调任何外部 API，用占位产物打通整条链路（默认）。
- `PIPELINE_MODE=real`：调真实接口。各 provider 的 real 分支待 key 到位后逐个验证接通。

## 当前状态

- ✅ 骨架 + mock 全链路（11 步跑通，产出占位 final.mp4）
- ⬜ 各 provider real 分支（TikHub / Whisper / StepFun / gpt-image）— 待 key 验证
- ⬜ HyperFrames real 渲染 — 待本地 `npx hyperframes` 验证
- ⬜ 素材复用库（assets 表 + 向量搜索）— 留接缝，攒够语料再建

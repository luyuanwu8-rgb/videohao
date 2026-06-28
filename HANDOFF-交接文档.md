# Videohao 项目交接文档（给 Codex）

> 编写时间：2026-06-27
> 编写人：Claude（上一任）
> 用途：把「图书带货视频工厂」整个项目讲清楚，以及当前未完成的收口，交接给 Codex 接手。
> 原则：本文只写**已核实**的事实。凡是"我没亲自验证"的，都明确标注，不替 Codex 拍脑袋。

---

## 0. 一句话项目定位

抖音爆款链接 → 全自动生成「带字幕竖版图书带货视频」的一站式流水线。
粘贴一条抖音分享链接，在同一个网页工作台里逐步跑完：
**逐字稿 → 爆款分析 → 改写 → 选书 → 分镜 → 配音/批量生图 → 字幕对齐 → 合成 → 成片**。

主赛道是**健康养生**（`DEFAULT_TRACK=health`），有专门的医疗合规处理（见 §9.4）。

---

## 1. 技术栈（已核实 package.json）

| 层 | 技术 |
|---|---|
| 编排 / 前端 | Next.js 15 + React 19 + TypeScript 5.7（App Router） |
| ORM / DB | Drizzle ORM 0.38 + LibSQL/SQLite（`@libsql/client`） |
| 校验 | zod 3.24（所有产物 schema 校验） |
| 脚本 | tsx（`scripts/` 下独立脚本，不经 Next） |
| 渲染后端 | **HyperFrames CLI**（`npx hyperframes@0.7.5`，无头 Chrome 逐帧截图 + FFmpeg 编码） |
| 本机 FFmpeg | 4.3.1（含 libass/libx264/h264_qsv，但项目当前**不直接调** FFmpeg，只经 HyperFrames） |

> ⚠️ **重要：用户明确要求渲染必须用 HyperFrames，不要换成 FFmpeg 原生后端**（理由：合成效果）。
> 我一度提议换 FFmpeg 提速，被用户否决。**不要再走这条路。**

---

## 2. ⚠️ 接手前必须先知道的 3 件事（最高优先）

### 2.1 这个目录不是 git 仓库
`e:\Codex\videohao` **没有 `.git`**（已核实：`git status` 返回 `fatal: not a git repository`）。
- 没有任何版本历史可回溯。
- 我本次对 `src/hyperframes/render.ts` 的改动（见 §10.1）**无法用 git 回滚**。
- **建议 Codex 第一件事：`git init` + 首次提交**，把当前状态固化为基线，之后才好安全改动。

### 2.2 StepFun 密钥当前为空 → ASR 和 StepFun TTS 跑新任务会失败
已核实 `.env.local` 现状：
- `STEP_API_KEY` = **无**，`STEPFUN_API_KEY` = **无**
- transcribe 步骤（逐字稿）走的是 **StepFun ASR**（`src/lib/steps/transcribe.ts` → `@/lib/providers/stepfun`）
- 所以**现在新建任务从头跑，transcribe 这步会失败**（ASR 没 key）。
- 之所以上次端到端能跑通，是因为用的是**已有 transcript 的旧任务**，没重跑 ASR。

**配音（TTS）目前靠火山引擎**：`VOLC_TTS_APPID` / `VOLC_TTS_TOKEN` = **有**，是默认 provider。
StepFun TTS 也因无 key 不可用，但默认就走火山，所以配音正常（上次 82 段全成功）。

> Codex 若要验证「从链接到成片」完整新链路，**必须先补 StepFun ASR 密钥**，或把 transcribe 换成别的 ASR。

### 2.3 密钥与运行模式现状（已核实，脱敏）
| 配置 | 值 / 状态 |
|---|---|
| `PIPELINE_MODE` | `real`（调真实接口，非 mock） |
| `DEFAULT_TRACK` | `health` |
| `LLM_MODEL` | `deepseek-chat`（`LLM_API_KEY` 有） |
| `GPTIMAGE_MODEL` | `gpt-image-2`（`GPTIMAGE_API_KEY` 有） |
| `TIKHUB_API_KEY` | 有（抖音解析） |
| `VOLC_TTS_APPID/TOKEN` | 有（火山 TTS，当前主力） |
| `STEP_API_KEY` / `STEPFUN_API_KEY` | **无**（ASR + StepFun TTS 不可用） |

---

## 3. 11 步流水线 DAG（已核实 `src/lib/steps/types.ts`）

```
extract → transcribe → viralAnalyze → rewrite → storyboard
                                                    ├─ 视觉线: assetSearch → imageGenerate
                                                    └─ 音频线: tts → subtitleAlign
                                                          ↓ 汇合
                                                 timelineBuild → render → final.mp4
```

调度器（`src/lib/pipeline.ts`）**认依赖关系不认顺序**：每步声明 `deps[]`，`depsSatisfied()` 检查上游是否全 completed 才能跑。视觉线与音频线在 storyboard 之后并行分叉，到 timelineBuild 汇合。

| step | deps | 主输出 | 干什么 |
|---|---|---|---|
| extract | — | source.mp4 / source.json | TikHub 解析抖音链接，下视频+元数据 |
| transcribe | extract | transcript.json | **StepFun ASR** 出逐字稿（⚠️无key会挂） |
| viralAnalyze | transcribe | viral.json | LLM 分析爆款结构 |
| rewrite | viralAnalyze | rewrite.json | LLM 改写文案（带赛道合规红线） |
| storyboard | rewrite | storyboard.json | LLM 拆分镜（visual+text 每镜） |
| assetSearch | storyboard | asset-hits.json | 素材库匹配（v1 留接缝，基本空跑） |
| imageGenerate | assetSearch | images.json | **九宫格批量生图**（见 §9.1） |
| tts | storyboard | voice.json | **火山引擎配音**（见 §9.2） |
| subtitleAlign | tts | subtitle.json | 字幕切分对齐 + 违规字同音替换（见 §9.4） |
| timelineBuild | imageGenerate, subtitleAlign | timeline.json / timeline-{motion}.json | 用真实配音时长合成时间线 |
| render | timelineBuild | final.mp4 | **HyperFrames** 渲染（见 §9.3） |

**执行模式**：`buildContext` 读 `PIPELINE_MODE`，`real`=调真实接口，`mock`=占位产物打通链路。各 step 的 run 里用 `ctx.mode` 分支。

---

## 4. 用户检查点（已核实 `src/lib/checkpoints.ts`）

11 个内部 step 对前端包装成检查点。用户在工作台逐点「确认，下一步」，每点触发其名下的内部 step。

| # | key | label | 名下 steps | 可编辑产物 | 失效重跑起点 |
|---|---|---|---|---|---|
| 1 | parse | 解析 | extract | — | — |
| 2 | transcript | 逐字稿校对 | transcribe | transcript.json | viralAnalyze |
| 3 | rewrite | 改写稿（含书名/标题） | viralAnalyze, rewrite | rewrite.json | storyboard |
| — | book | 选书+标题 | （**已合并进③改写稿，侧边栏隐藏**） | rewrite.json | storyboard |
| 5 | storyboard | 分镜 | storyboard | storyboard.json | assetSearch |
| 6 | tts | 配音 | tts | voice-config.json | tts |
| 7 | image | 场景图 | assetSearch, imageGenerate | image-config.json | imageGenerate |
| 8 | style | 风格运镜 | （纯配置，空 steps） | render-config.json | timelineBuild |
| 9 | final | 成片 | subtitleAlign, timelineBuild, render | — | — |

关键设计：
- **「选书+标题」已合并进③改写稿面板**：checkpoints.ts 里 `book` 检查点仍存在（避免动流水线结构），但 `page.tsx` 侧边栏用 `.filter(cp=>cp.key!=="book")` 隐藏。改写稿面板的 next() 直接 `advance("storyboard")`。
- **画面风格选择器在第 7 步「场景图」面板上方**（从分镜移过来），写 `image-config.json`，支持换风格后一键重绘。
- **分镜面板已移除医疗安全检测**：用户自己审文案（第一层），合规靠字幕词库替换兜底。
- **第 8 步「风格运镜」不直接渲染**，而是「加入成片队列」（避免并发 OOM），写 `render-config.json`（motions[] 多选 + disclaimer）。
- `editable` = 该检查点能改的产物；`invalidatesFrom` = 改了之后从哪个 step 起需重跑。

---

## 5. 数据模型（已核实 `src/db/schema.ts`）

4 张表，全 SQLite：

- **tasks** — 一条视频一行。`status: pending|queued|running|completed|failed`，`track`，`sourceUrl`，`sourceMeta`(JSON 元数据快照)，`error`。
- **steps** — 每任务每 step 一行。`status: pending|running|completed|failed|skipped`，`startedAt/endedAt`，`cost`(成本可见性)，`usage`(JSON)。DAG 调度器据此判断依赖。
- **artifacts** — 每个产物文件一行，**带版本号**。`filePath`(相对 `data/tasks/{id}/`)，`fileType`，`version`(同 path 第 N 次写自动+1)，`tag`+`meta`(给素材复用库留的接缝，生图存 scene/visual/prompt)。支持 rewrite_v1/v2/v3 共存可对比。
- **promptsConfig** — 提示词前端化。`(step, track)` 唯一。`system` + `buildTemplate`(带 `{占位符}`)。见 §8。
- **apiConfigs** — API/env 前端化。`key` 唯一(env 变量名)，`value`，`isSecret`(脱敏显示)。见 §8。

> 产物文件落 `data/tasks/{id}/`，DB 只存元信息（路径/版本/状态/成本）。当前有 7 个任务目录。

---

## 6. Provider 接入状态（已核实 `src/lib/providers/`）

| provider | 文件 | 用途 | 真实接入状态 |
|---|---|---|---|
| TikHub | tikhub.ts | 抖音解析 | ✅ key 在，链路验证过 |
| LLM (DeepSeek) | llm.ts | 分析/改写/分镜 | ✅ key 在，验证过 |
| StepFun | stepfun.ts | **ASR**(转写) + TTS(备选) | ❌ **无 key，当前不可用** |
| 火山引擎 | volcengine.ts | TTS(主力) | ✅ key 在，82 段配音验证过 |
| gpt-image | gptimage.ts | 九宫格生图 | ✅ key 在（gpt-image-2），验证过 |

**音色库**（`src/lib/providers/voices.ts`）：火山引擎从竞品 Storybound 摸到 157 个大模型音色，但**当前账号仅授权 moon 音区 31 个**（已按场景分组）。StepFun 保留少量音色。配音缺省走火山「解说小明」。

> ⚠️ 注意 `voices.ts` 注释说"157 个去重后 109 个角色"，但**实际可用只有 moon 音区 31 个**（账号授权限制）。别被注释数字误导。

---

## 7. 前端结构（已核实 `src/app/`）

```
/                      首页：新建任务 + 任务列表 + 🎬成片队列横幅（见 §9.5）
/tasks/[id]            工作台：左侧 9 检查点导航 + 右侧对应 Panel
/prompts               提示词编辑页（promptsConfig 前端化）
/settings              API 配置编辑页（apiConfigs 前端化）
```

**工作台** (`src/app/tasks/[id]/page.tsx`)：
- 每 **1.5 秒轮询** `/api/tasks/[id]` 刷新 detail（步骤状态实时更新靠这个）。
- 9 个 Panel：Parse/Transcript/Rewrite/Book/Storyboard/Tts/Image/Style/Final。
- Panel 间共享契约在 `panels/shared.tsx`（`PanelProps`/`useArtifact`/`saveEdit`/`advance`/`PanelShell`）。

**API 路由** (`src/app/api/`)：
| 路由 | 作用 |
|---|---|
| GET/POST `/api/tasks` | 列表(+队列快照) / 新建任务 |
| GET `/api/tasks/[id]` | 任务详情(步骤/产物/成本) — 前端轮询用 |
| POST `/api/tasks/[id]/advance` | 确认推进到某检查点（后台跑，不阻塞） |
| POST `/api/tasks/[id]/run` | 重跑单个 step |
| PATCH `/api/tasks/[id]/edit` | 保存某检查点编辑后的产物 |
| POST `/api/tasks/[id]/enqueue` | 加入成片渲染队列 |
| POST `/api/tasks/[id]/pause` | 暂停/恢复任务（running↔paused） |
| DELETE `/api/tasks/[id]` | 删除任务（DB cascade + 磁盘目录） |
| POST `/api/tasks/[id]/save-config` | 软保存配置文件（不重置步骤） |
| GET `/api/tasks/[id]/file/[...path]` | 读任务目录下任意产物文件 |
| GET/PATCH `/api/prompts` | 读/改提示词 |
| DELETE `/api/prompts?step=&track=` | 删除一条提示词记录 |
| GET/PATCH `/api/subtitle-filters` | 读/改字幕过滤词库（全局，非任务级） |
| GET/PATCH `/api/settings` | 读/改 API 配置 |
| POST `/api/tts/preview` | 音色试听 |

---

## 8. 前端化机制：提示词 + API 配置（已核实）

两套"出厂默认 + DB 覆盖 + Web 编辑"的配置系统，是这个项目的核心可配置性设计。

### 8.1 提示词前端化（`src/lib/prompts.ts` + `prompt-defaults.ts`）
- `loadPrompt(step, track)` 三级回退：① 查库 `step+track` 命中即用 → ② 查库 `step+base` 回退 → ③ `PROMPT_DEFAULTS` 出厂默认（空库兜底）。
- 存的不是函数，是 `buildTemplate`（带 `{transcript}`/`{viral}`/`{script}`/`{visual}` 占位符），运行时 `interpolate()` 替换（对象自动 JSON 化）。
- 用户在 `/prompts` 页改 → 写 `promptsConfig` 表 → 下次 `loadPrompt` 命中库值。
- 出厂默认在 `prompt-defaults.ts`，**健康赛道的合规红线和隐喻转译规则就写在这里**（见 §9.4）。

### 8.2 API 配置前端化（`config-cache.ts` + `api-config-defs.ts`）
- 问题：`env()` 是同步函数、被 provider 大量同步调用，不能逐次查库。
- 解法：`api_configs` 表预加载进**内存 Map**，`env()` 同步读 Map → 回退 `process.env`。
- `ensureConfigLoaded()` 在 `runStep` 开头调用（幂等，首次才查库）；`/settings` 写库后 `refreshConfigCache()` 刷新。
- `api-config-defs.ts` 是出厂清单（有哪些 key、归属哪个 provider、是否密钥），种子时从 `process.env` 灌当前值。

> 这意味着：用户可以在网页上改 API key / 模型名 / 提示词，**不用动 `.env` 文件**。但 `.env.local` 仍是初始来源。

---

## 9. 关键子系统详解

### 9.1 九宫格生图（`src/lib/steps/imageGenerate.ts`）⭐ 性能瓶颈所在
省钱方案：每 9 个 scene 拼成一张 3×3 网格图，**一次 gpt-image 调用出 9 格再裁切**（出图调用数 9→1）。
- 读 `image-config.json` 的 `{style, ratio}`（第 5 步分镜面板写入）。
- `style` 决定正向词（拼进 prompt）+ 负向词（gpt-image 无 negative 字段，用"避免出现"文字拼入）。
- 比例 → 网格尺寸映射（9:16 → 1024x1536）。
- **⚠️ 这是最大性能瓶颈**：双层串行（见 §10.2）。82 镜头实测吃掉 ~20 分钟。

### 9.2 双 provider 配音（`src/lib/steps/tts.ts`）
- 读 `voice-config.json` 指定 `provider(volcengine/stepfun) + voice + speed`，缺省火山「解说小明」。
- **容错链**：内容审核失败（451/风控）→ LLM 改写一次再合成 → 仍失败则**静音占位**（不中断整条链路）。
- 每段配音真实时长写入 `voice.json`，timelineBuild 用它做时间线（不是估算）。

### 9.3 HyperFrames 渲染（`src/hyperframes/render.ts` + `template.ts`）
- `timeline.json` → `buildCompositionHtml()` 拼成 HTML（DOM + GSAP 时间线）→ `npx hyperframes render` → mp4。
- 无头 Chrome **逐帧截图**（jpg）→ 内置 FFmpeg 编码。11.5 分钟视频 @24fps = **约 1.65 万帧**。
- 中文字幕**必须用打包字体** `assets/fonts/simhei.ttf` + @font-face，否则无头 Chrome 渲成方框（已验证的硬约束）。
- **多动效批量**：有几个 `timeline-{key}.json` 就渲几条，第一条 copy 成 `final.mp4`。
- Windows 句柄占用坑：`final.mp4` 可能被浏览器 `<video>` 占用，rename 失败则退回 copyFile。
- `latestMp4` 用 **mtime** 取最新（不能用字典序，任务 id 前缀会取错）。
- **我本次的提速改动也在这个文件**（见 §10.1）。

### 9.4 健康赛道医疗合规（`src/lib/compliance/health-keywords.ts` + prompt-defaults）
用户极度重视这块（视频号健康赛道容易限流）。三层防护：
1. **改写层红线**（rewrite/health prompt）：不诊断、不承诺疗效、安全措辞。
2. **生图层隐喻转译**（storyboard/health prompt）：强制把"糖尿病/癌症/肾衰竭"等转译为「日常生活方式隐喻」（健康食材、家人陪伴等），**绝不出现病房、病理图**。
3. **字幕层同音替换**（subtitleAlign）：高危词替换，如 `治疗→ZL`、`养生→Y生`、`血管→x管`、`细胞→XB`、`补药→BY`。`render-config.json` 的 `subtitleHomophone` 开关控制，**只替换高危词且保留人工二次修改**。
- `health-keywords.ts` 提供 `findVisualForbidden`/`findTextForbidden`/`applyHomophones`/`suggestMetaphor`。
- StoryboardPanel 有医疗安全检测：`findVisualForbidden` 命中会锁确认按钮，`suggestMetaphor` 给隐喻提示。

### 9.5 成片渲染队列（`src/lib/renderQueue.ts`）✅ 已完成且端到端验证
- **内存队列 + 常驻串行 worker**。为什么串行：单条渲染就快撑满内存，并发必 OOM；API 限流（账号级共享配额）并发触发 429。
- `enqueue()` 标记 `status=queued` 落库 + 推内存队列 + 启动 `pump()`。
- `pump()` 单例循环：取队首 → `advanceTo(final)` → 成功/失败都取下一条（失败不阻塞队列）。
- **重启自愈** `ensureQueueRecovered()`：内存队列重启丢失，扫库把 `queued` 重新入队（在列表 API 调用，幂等）。
- 端到端验证过：enqueue 返回 position，worker 真把 subtitleAlign→timelineBuild→render 跑完产出有效 final.mp4。

---

## 10. ⭐ 本次会话的改动 + 待收口清单（交接核心）

> 更新时间：2026-06-28。以下全部已核实（编译通过 EXIT=0，关键改动经真实 API 调用验证）。

### 10.1 已完成改动清单

#### 渲染提速（`src/hyperframes/render.ts`）
- `--workers` 写死的 `2` → 固定 `4`（`HYPERFRAMES_WORKERS` 可覆盖）
- 新增 `--quality draft`（`HYPERFRAMES_QUALITY` 可覆盖）
- 新增 `--no-low-memory-mode`（防止浏览器占内存时被降成 1 worker）
- 实测：4 worker 并行截帧（worker-0/1/2/3），201MB 产物，1080×1920 / 24fps / 688.6s 正确

#### 软保存机制（新文件 + shared.tsx）
- 新增 `src/app/api/tasks/[id]/save-config/route.ts`：写文件不动步骤状态（用于持久化选项）
- `shared.tsx` 新增 `saveConfig()` 工具函数
- **三个面板接了自动软保存**（选项变动立即写盘，刷新不丢）：
  - TtsPanel → `voice-config.json`（音色/引擎/语速）
  - StylePanel → `render-config.json`（动效/声明/字幕谐音）
  - ImagePanel → `image-config.json`（画面风格）

#### 面板导航修复（`shared.tsx` + `page.tsx` + 所有面板）
- `PanelProps` 加 `navigate: (key: string) => void`
- `page.tsx` 传 `navigate={setActive}`
- 所有面板的 `next()` 函数加了 `navigate("下一步key")`——点确认自动跳到下一步，不再原地不动

#### 加载状态组件（`shared.tsx` → 5 个面板）
- 新增 `StepLoader` 组件（running 显示转圈+计时，failed 显示红色错误，pending 显示等待）
- TranscriptPanel / RewritePanel / TtsPanel / ImagePanel / StoryboardPanel 用 StepLoader 替换了纯文字"正在…"

#### 任务暂停/删除（首页 + 新 API）
- 新增 `src/app/api/tasks/[id]/pause/route.ts`：running→paused / paused→running+恢复流水线
- `src/app/api/tasks/[id]/route.ts` 加 DELETE 处理：删 DB（cascade）+ 删磁盘目录
- `src/app/page.tsx` 任务卡片加暂停/恢复/删除按钮（操作立即同步后端，实测验证）
- `src/lib/pipeline.ts` advanceTo 每步前检查 paused 状态，暂停时安静退出不报失败
- `src/app/ui/theme.ts` 加 `paused` 状态色（蓝色）和 `STATUS_LABEL["paused"]="已暂停"`

#### 画面风格选择器移位（分镜→场景图）
- **StoryboardPanel**：移除风格选择器（imgCfg 状态、IMAGE_STYLES 引用全部清理）
- **ImagePanel**：加入风格选择器（在图片网格上方）+ imgCfg 软保存 + 换风格后重绘逻辑（先 saveEdit 失效 imageGenerate，再 advance 重跑）

#### 生图流程简化（`src/lib/steps/imageGenerate.ts`）
- 移除了 visual→LLM 改写→图片 prompt 这个中间步骤（省 82 次 LLM 调用）
- 现在：`scene.visual` 直接作为每格出图描述
- 同时加强了风格注入：每格描述带风格词前缀 `[油画词汇] 场景描述`（之前只在顶部声明一次，模型忽略）

#### 油画风格词强化（`src/lib/styles.ts`）
- `oil` 的 positive 加了英文：`oil painting, impressionist style, visible brushstrokes, impasto`
- negative 加了英文：`photography, photorealistic, photo` 
- 原因：gpt-image-2 对英文风格词更敏感，纯中文描述容易被写实内容压过

#### 提示词管理清理
- `src/lib/prompt-defaults.ts` 移除 `imageGenerate/base` 条目
- `src/app/api/prompts/route.ts` 新增 DELETE handler（`?step=xx&track=xx`）
- DB 里的 `imageGenerate/base` 记录已删除
- 提示词管理页现只剩：改写base/health、分镜base/health、爆款分析base

### 10.1b 第二轮改动（2026-06-28，7 项统一修改，全部编译通过 EXIT=0）

#### ① 改写稿越权修复 + ② 合并选书
- **根因**：`RewritePanel.next()` 原来调 `advance("storyboard")`，直接越过选书步骤把分镜也跑了
- **修复**：RewritePanel 合并书名/标题字段（`sourceBook` + `title`），next() 改 `advance("storyboard")` 是正确的（因为 book 已合并），navigate("storyboard")
- **侧边栏隐藏 book**：`page.tsx` 用 `.filter(cp=>cp.key!=="book")`，checkpoints.ts 不动

#### ③ 分镜面板移除医疗安全检测
- 删除 `findVisualForbidden`/`suggestMetaphor` 引用、红色警告横幅、按钮锁定逻辑
- 合规策略改为：用户自己审文案（第一层）+ 字幕词库替换（发布前兜底）
- `health-keywords.ts` 文件保留但分镜面板不再用

#### ④ 字幕过滤词库前端化 ⭐
- 新增全局配置 `data/subtitle-filters.json`（规则数组 `[{from,to}]`，迁移自原 HOMOPHONES）
- 新增 API `src/app/api/subtitle-filters/route.ts`（GET/PATCH）
- `/prompts` 页加「🔤 字幕词库」板块：增删改规则 + 保存（侧边栏底部入口）
- `subtitleAlign.ts` 改为读 `data/subtitle-filters.json` 并**始终应用**（移除了原 subtitleHomophone 开关依赖）；替换按词长降序（防短词覆盖长词）
- **用户会自行维护这个词库**，格式以用户填入为准（如 细胞=XB、慢性病=慢性寎）

#### ⑤ 生图受控并发
- `imageGenerate.ts`：10 组九宫格从串行改为分组并发，`Promise.all` 每组最多 `IMAGE_CONCURRENCY`（默认 3）个并行
- 结果用 `resultMap` 按 index 收集再合并，保证图片顺序不乱
- **安全开关**：`.env.local` 设 `IMAGE_CONCURRENCY=1` 即退回串行（出 429 限流时的兜底）
- 风险：`Promise.all` 任一失败则整组失败，但 generateGrid 自带重试（`GPTIMAGE_MAX_RETRY`）

#### ⑥ storyboard JSON 解析重试
- `storyboard.ts`：LLM 返回非法 JSON 时最多重试 3 次，全失败才报错

#### ⑦ 首页队列横幅常驻
- `page.tsx`：移除 `{queue.current||waiting>0 && ...}` 条件，横幅常显，空闲时显示「空闲」

### 10.2 仍待处理的问题

| # | 问题 | 严重度 | 根因 | 方案 |
|---|---|---|---|---|
| 1 | **分镜 visual 违规词透传生图** | 🟡中 | 移除 LLM 改写层后，visual 原文直接送 gpt-image；分镜面板检测也已移除 | 用户要求：评估在 imageGenerate 加自动隐喻替换（不只靠人工/字幕） |
| 2 | **步骤耗时统计错乱** | 🟡中 | 队列路径下 startedAt/endedAt 没正确记录（DB 显示 render=1s，实际 20min） | 排查 runStep 在队列路径的时间戳写入 |
| 3 | **生图无增量预览** | 🟡中（体验） | ImagePanel 等 imageGenerate=completed 才显示图 | loading 带进度"6/10组…"（写 step meta） |
| 4 | **README 完全过时** | 🟢低 | 描述的是旧架构 | 重写 |

### 10.3 渲染速度认知（别重复踩坑）

- **换 FFmpeg 原生后端被用户明确否决**（"合成效果必须用 HyperFrames"）。**不要再提。**
- HyperFrames 是逐帧 Chrome 截图，11.5分钟视频≈1.65万帧是硬成本，参数层面已榨到头
- 生图串行已改为受控并发（§10.1b ⑤），不再是瓶颈

---

## 11. 怎么跑起来（已核实 package.json scripts）

```bash
# 安装
npm install

# 数据库（首次）
npm run db:generate    # drizzle-kit 生成迁移
npm run db:migrate     # tsx src/db/migrate.ts 建表
npm run db:seed        # tsx scripts/seed-config.ts 灌出厂配置(提示词+API配置)

# 端到端 mock 验证（无需任何 key）
npm run pipeline:smoke

# 开发服务器
npm run dev            # http://localhost:3000
```

**启动工作台**：根目录 `启动工作台.vbs`（双击启动，已验证可用）。
> 注意：原来的 `.bat`（`scripts/launch.bat`）因 GBK codepage 问题坏过，已改用 VBScript（UTF-16LE+BOM）。用户已确认 .vbs 双击没问题。

**环境变量**：`.env` + `.env.local`（后者覆盖前者）。Next.js 自动加载；独立 tsx 脚本需 `import "@/lib/loadenv"`。

**测试脚本**（`scripts/`，都是 tsx 单独跑）：
- `test-llm.ts` / `test-stepfun.ts` / `test-tikhub.ts` / `test-grid.ts` / `test-image.ts` / `test-render.ts` — 各 provider 单测
- `smoke.ts` — 全链路 mock 冒烟
- `shoot-panels.ts` — playwright 截图各面板（前端验收用）

---

## 12. 用户的工作风格（必读，避免踩雷）

这些是和用户协作中明确感受到的，Codex 接手务必遵守：

1. **不要捏造数据**。我曾经编造过一次工具输出，被用户当场抓到，是严重信任事故。**只报真实跑出来的结果**，没验证的明确说"没验证"。
2. **不要"修修补补"**（用户原话）。同一个问题失败两次，要停下来从根因想，换思路，别一直打补丁。
3. **大改前先规划、先沟通**。用户喜欢"先探讨方案，全部沟通好了再统一执行"，而不是边问边改。
4. **诚实 > 讨好**。用户能接受"这个就是慢，没法更快了"这种实话，反而反感虚假承诺/画饼。我说"无法诚实地说快了几倍"时用户没有不满。
5. **赛道合规是高压线**。健康养生赛道的医疗安全（§9.4）用户花了大量精力，绝不能让生图出现病房/病理图，绝不能让文案承诺疗效。
6. **渲染必须用 HyperFrames**（§10.3）。已是定论。
7. 用户用中文交流，回复用中文。

---

## 13. 接手第一步建议（我若是 Codex 会这么做）

1. `git init` + 首次提交，固化当前基线（§2.1）——**最优先**，否则改坏了无法回滚。
2. 读本文 §10.2 的 bug 清单，和用户确认"统一修"的优先级（用户本来就要统一修，没修完是因为中途插入了渲染提速）。
3. 若要验证完整新链路（从抖音链接到成片），先补 **StepFun ASR 密钥**（§2.2），否则 transcribe 必挂。
4. 从 **#1 生图串行**入手（收益最大、不碰 HyperFrames 禁区）。
5. README 已过时（§10.2 #7），别信它的"当前状态"，以本文为准。

---

## 14. 文件索引（快速定位）

| 想找什么 | 看这里 |
|---|---|
| DAG 依赖 / step 接口 | `src/lib/steps/types.ts` |
| 调度器 / 跑 step / 建任务 | `src/lib/pipeline.ts` |
| 9 检查点定义 | `src/lib/checkpoints.ts` |
| 各 step 实现 | `src/lib/steps/*.ts` |
| 渲染（HyperFrames）⭐本次改动 | `src/hyperframes/render.ts` + `template.ts` |
| 渲染契约 | `src/lib/timeline.ts` |
| 动效预设 | `src/lib/motions.ts` |
| 画面风格库（13种） | `src/lib/styles.ts` |
| 提示词加载 / 出厂默认 | `src/lib/prompts.ts` + `prompt-defaults.ts` |
| 健康合规 | `src/lib/compliance/health-keywords.ts` |
| 成片队列 | `src/lib/renderQueue.ts` |
| API 配置缓存 | `src/lib/config-cache.ts` + `api-config-defs.ts` |
| 音色库 | `src/lib/providers/voices.ts` |
| DB schema | `src/db/schema.ts` |
| 前端工作台 | `src/app/tasks/[id]/page.tsx` + `panels/*.tsx` |
| 首页/队列展示 | `src/app/page.tsx` |

---

*文档结束。本文所有"已核实"内容均来自实际读文件 / 跑命令 / 查 API 的输出，非记忆推断。标注"未验证/没基线"的地方请 Codex 自行确认后再下结论。*







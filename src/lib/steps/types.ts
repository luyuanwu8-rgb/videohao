import type { Task } from "@/db/schema";

/**
 * Step 统一接口 + DAG 依赖图。
 *
 * 调度器认"依赖关系"，不认"顺序列表"。
 * 每个 step 声明它依赖哪些上游 step，调度器据此决定可跑/可并行/可重跑。
 */

export type StepName =
  | "extract"
  | "transcribe"
  | "viralAnalyze"
  | "rewrite"
  | "storyboard"
  | "assetSearch"
  | "director"
  | "imageGenerate"
  | "tts"
  | "subtitleAlign"
  | "timelineBuild"
  | "render";

export interface StepContext {
  task: Task;
  taskDir: string; // 绝对路径 data/tasks/{id}
  track: string; // 赛道，用于 loadPrompt
  mode: "mock" | "real";
  /** 读取上游 step 的产物（解析 + zod 校验由调用方负责） */
  readArtifact: (relPath: string) => Promise<string>;
  readJSON: <T>(relPath: string) => Promise<T>;
  /** 写产物并登记到 artifacts 表（自动版本号） */
  writeArtifact: (
    relPath: string,
    data: string | Buffer,
    opts?: { fileType?: string; tag?: string; meta?: Record<string, unknown> }
  ) => Promise<void>;
  writeJSON: (
    relPath: string,
    data: unknown,
    opts?: { tag?: string; meta?: Record<string, unknown> }
  ) => Promise<void>;
  /** 只登记 artifact 到 DB（文件已由 provider 写盘，不重写内容） */
  registerArtifact: (
    relPath: string,
    opts?: { fileType?: string; tag?: string; meta?: Record<string, unknown> }
  ) => Promise<void>;
  /** 记成本（token/调用花费），汇总到 steps.cost */
  reportCost: (cost: number, usage?: Record<string, unknown>) => void;
  log: (msg: string) => void;
}

export interface StepResult {
  ok: boolean;
  error?: string;
}

export interface StepDef {
  name: StepName;
  /** 依赖的上游 step（DAG 边）。空数组 = 根节点 */
  deps: StepName[];
  /** 主输出产物的相对路径，用于判断是否已完成、是否需重跑 */
  output: string;
  run: (ctx: StepContext) => Promise<StepResult>;
}

/**
 * 流水线 DAG（11 步）。
 *
 *   extract → transcribe → viralAnalyze → rewrite → storyboard
 *                                                      ├─ 视觉线: assetSearch → imageGenerate
 *                                                      └─ 音频线: tts → subtitleAlign
 *                                                            ↓ 汇合
 *                                                   timelineBuild → render
 */
export const PIPELINE_DEPS: Record<StepName, StepName[]> = {
  extract: [],
  transcribe: ["extract"],
  viralAnalyze: ["transcribe"],
  rewrite: ["viralAnalyze"],
  storyboard: ["rewrite"],
  // 视觉线
  assetSearch: ["storyboard"],
  director: ["assetSearch"], // 导演：读全文+分镜，逐镜规划镜头语言/选角
  imageGenerate: ["director"],
  // 音频线（与视觉线并行）
  tts: ["storyboard"],
  subtitleAlign: ["tts"],
  // 汇合：需要图(时长占位)+音(真实时长)+字幕
  timelineBuild: ["imageGenerate", "subtitleAlign"],
  render: ["timelineBuild"],
};

export const PIPELINE_ORDER: StepName[] = [
  "extract",
  "transcribe",
  "viralAnalyze",
  "rewrite",
  "storyboard",
  "assetSearch",
  "director",
  "imageGenerate",
  "tts",
  "subtitleAlign",
  "timelineBuild",
  "render",
];

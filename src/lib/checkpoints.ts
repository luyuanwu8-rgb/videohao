import type { StepName } from "./steps/types";

/**
 * 检查点(Checkpoint)— 把 11 步内部流水线包装成用户可见的 9 个审阅节点。
 *
 * 工作台是"分步人工确认"模型:用户停在某个检查点审阅/编辑产物,
 * 点"确认下一步"→ 跑下一个检查点名下的内部 step(们)→ 再停下等确认。
 *
 * - steps: 该检查点点"下一步"时要跑的内部 step(按序)。空数组 = 纯配置点(不跑引擎,只编辑配置)。
 * - editable: 该检查点可编辑的产物 json(相对 data/tasks/{id}/)。前端据此决定能改什么。
 * - silentBefore: 进入该检查点前要静默跑完的机器步(用户不感知,不单独成节点)。
 */
export interface Checkpoint {
  key: string;
  label: string;
  steps: StepName[];
  editable?: string;
  /** 编辑该检查点产物时,需要级联重置/重跑的下游起点 step(用于"改了上游→下游失效") */
  invalidatesFrom?: StepName;
}

export const CHECKPOINTS: Checkpoint[] = [
  { key: "parse", label: "解析", steps: ["extract"] },
  {
    key: "transcript",
    label: "逐字稿校对",
    steps: ["transcribe"],
    editable: "transcript.json",
    invalidatesFrom: "viralAnalyze",
  },
  {
    key: "rewrite",
    label: "改写稿",
    steps: ["viralAnalyze", "rewrite"],
    editable: "rewrite.json",
    invalidatesFrom: "storyboard",
  },
  {
    key: "book",
    label: "选书 + 标题",
    steps: [],
    editable: "rewrite.json",
    invalidatesFrom: "storyboard",
  },
  {
    key: "storyboard",
    label: "分镜",
    steps: ["storyboard"],
    editable: "storyboard.json",
    invalidatesFrom: "director",
  },
  {
    key: "director",
    label: "导演分镜",
    steps: ["assetSearch", "director"],
    editable: "director.json",
    invalidatesFrom: "imageGenerate",
  },
  {
    key: "tts",
    label: "配音",
    steps: ["tts"],
    editable: "voice-config.json",
    invalidatesFrom: "tts",
  },
  {
    key: "image",
    label: "场景图",
    steps: ["imageGenerate"],
    editable: "image-config.json",
    invalidatesFrom: "imageGenerate",
  },
  {
    key: "style",
    label: "风格运镜",
    steps: [],
    editable: "render-config.json",
    invalidatesFrom: "timelineBuild",
  },
  { key: "final", label: "成片", steps: ["subtitleAlign", "timelineBuild", "render"] },
];

/** 所有检查点名下的内部 step,按检查点顺序展开(用于"跑到某检查点为止") */
export function stepsUpTo(checkpointKey: string): StepName[] {
  const out: StepName[] = [];
  for (const cp of CHECKPOINTS) {
    out.push(...cp.steps);
    if (cp.key === checkpointKey) break;
  }
  return out;
}

export function findCheckpoint(key: string): Checkpoint | undefined {
  return CHECKPOINTS.find((c) => c.key === key);
}

/** 某检查点对应的"主产物 step"(取该检查点最后一个内部 step),用于判断完成度 */
export function lastStepOf(checkpointKey: string): StepName | undefined {
  const cp = findCheckpoint(checkpointKey);
  if (!cp || cp.steps.length === 0) return undefined;
  return cp.steps[cp.steps.length - 1];
}

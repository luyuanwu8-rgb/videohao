import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { StepDef } from "./types";
import { generateGrid, sliceGrid } from "@/lib/providers/gptimage";
import { directorSchema, imagesSchema, type ImageItem, type Beat, type Director } from "@/lib/domain";
import { imageStyle, DEFAULT_STYLE, COMMON_NEGATIVE, type ImageStyle } from "@/lib/styles";
import { z } from "zod";

/**
 * imageGenerate: 按导演的「画面节拍」出图——每拍一张图(图数 = 节拍数,远少于句数)。
 *
 * 省钱方案：每 9 拍拼成一张 3×3 网格图，一次出图再裁成 9 张。
 * 每格 prompt = 导演的 composition + 角色卡(若 use=cast:X) + 全局视觉基调。
 * 风格(image-config.json)作最外层正向词；负向词用"避免出现"拼入(gpt-image 无 negative 字段)。
 *
 * 注：九宫格仍有"模型放错格"的固有顺序风险，由场景图面板的手动重排兜底。
 */

// 画面风格 + 比例配置(工作台「场景图」面板写入)
const imageConfigSchema = z.object({
  style: z.string().default(DEFAULT_STYLE),
  ratio: z.string().default("9:16"),
});

// 比例 → 网格图请求尺寸。整张网格图比例 = 单格比例（3×3 等比）。
const RATIO_GRID_SIZE: Record<string, string> = {
  "9:16": "1024x1536",
  "3:4": "1024x1536",
  "1:1": "1024x1024",
  "4:3": "1536x1024",
  "16:9": "1536x1024",
};
const DEFAULT_RATIO = "9:16";

/** 把一个节拍展开成"单格出图描述"：角色卡 + 景别 + 构图（导演已写好医疗安全的 composition） */
export function beatToCellPrompt(beat: Beat, plan: Director): string {
  const parts: string[] = [];
  // use 可能是 "cast:main"(带前缀) 或 "main"(裸 id) —— 都去 cast 里查同名 id。
  // "空镜"/"配角" 等不匹配任何 cast id，自然不注入人物，符合预期。
  if (beat.use) {
    const id = beat.use.startsWith("cast:") ? beat.use.slice(5) : beat.use;
    const c = plan.cast.find((x) => x.id === id);
    if (c) parts.push(`人物:${c.bible}`);
  }
  if (beat.shotType) parts.push(`景别:${beat.shotType}`);
  parts.push(beat.composition);
  return parts.join("，");
}

/** 比例 → 单图请求尺寸（与批量九宫格走同一比例档，保证重生成的图和其余图一致）。 */
export function ratioToSize(ratio: string): string {
  return RATIO_GRID_SIZE[ratio] ?? RATIO_GRID_SIZE[DEFAULT_RATIO];
}

/**
 * 单图重生成 prompt（修图用）：与批量同款风格正/负向词 + 节拍画面，
 * 末尾追加用户修改意见(优先级最高)。feedback 为空时等于按原描述重画。
 */
export function buildSinglePrompt(beat: Beat, plan: Director, style: ImageStyle, ratio: string, feedback?: string): string {
  const base = beatToCellPrompt(beat, plan);
  const negative = [style.negative, COMMON_NEGATIVE].filter(Boolean).join(", ");
  const fb = (feedback ?? "").trim();
  return (
    `生成一张 ${ratio} 竖版画面。\n` +
    `【画面风格：${style.label}】${style.positive}。\n` +
    `【画面内容】${base}\n` +
    (fb ? `【务必按以下要求修改，与上文冲突时以此为准】${fb}\n` : "") +
    `【避免出现】${negative}。\n` +
    `不要任何文字、序号、水印、画框。`
  );
}

export const imageGenerate: StepDef = {
  name: "imageGenerate",
  deps: ["director"],
  output: "images.json",
  run: async (ctx) => {
    const plan = directorSchema.parse(await ctx.readJSON("director.json"));
    await mkdir(join(ctx.taskDir, "images"), { recursive: true });
    await mkdir(join(ctx.taskDir, "images", "_grids"), { recursive: true });

    // 读画面风格 + 比例配置(缺省走 schema 默认:油画印象 + 9:16)
    let cfg = imageConfigSchema.parse({});
    try {
      cfg = imageConfigSchema.parse(await ctx.readJSON("image-config.json"));
    } catch {
      /* 无配置走默认 */
    }
    const style = imageStyle(cfg.style);
    const ratio = cfg.ratio;
    const gridSize = RATIO_GRID_SIZE[ratio] ?? RATIO_GRID_SIZE[DEFAULT_RATIO];
    const globalTone = plan.visualTone ? `整片基调:${plan.visualTone}。` : "";

    const items: ImageItem[] = [];
    const batches = chunk(plan.beats, 9);
    const CONCURRENCY = Number(process.env.IMAGE_CONCURRENCY ?? "3");

    // 受控并发：每次最多同时发 CONCURRENCY 个 gpt-image 请求
    const resultMap = new Map<number, ImageItem[]>();
    for (let start = 0; start < batches.length; start += CONCURRENCY) {
      const group = batches.slice(start, start + CONCURRENCY);
      await Promise.all(group.map(async (batch, gi) => {
        const b = start + gi;
        const cellPrompts = batch.map((beat) => globalTone + beatToCellPrompt(beat, plan));
        const gridPrompt = buildGridPrompt(cellPrompts, ratio, style);
        const gridRel = `images/_grids/grid_${b}.png`;
        const { cost } = await generateGrid(gridPrompt, join(ctx.taskDir, gridRel), gridSize, ctx.mode);
        ctx.reportCost(cost, { provider: "gptimage", grid: b, cells: batch.length });

        // 每拍一张图，文件名用 beat.id
        const cellRels = batch.map((beat) => `images/${beat.id}.png`);
        await sliceGrid(join(ctx.taskDir, gridRel), cellRels.map((r) => join(ctx.taskDir, r)), ctx.mode);

        const batchItems: ImageItem[] = [];
        for (let i = 0; i < batch.length; i++) {
          const beat = batch[i];
          await ctx.registerArtifact(cellRels[i], {
            fileType: "png", tag: beat.composition,
            meta: { beatId: beat.id, sceneIds: beat.sceneIds, prompt: cellPrompts[i], grid: gridRel, cell: i },
          });
          batchItems.push({ beatId: beat.id, sceneIds: beat.sceneIds, imagePath: cellRels[i], prompt: cellPrompts[i], visual: beat.composition, reused: false });
        }
        resultMap.set(b, batchItems);
      }));
    }
    // 按原始顺序合并
    for (let b = 0; b < batches.length; b++) {
      items.push(...(resultMap.get(b) ?? []));
    }

    const images = imagesSchema.parse({ items });
    await ctx.writeJSON("images.json", images);
    ctx.log(`生图: ${items.length} 张(每拍一张) / ${batches.length} 张网格图（比例 ${ratio}）`);
    return { ok: true };
  },
};

/** 把 ≤9 条单格 prompt 拼成一个 3×3 网格出图 prompt（含风格正/负向词） */
function buildGridPrompt(cellPrompts: string[], ratio: string, style: ImageStyle): string {
  // 风格词作每格前缀，确保 gpt-image 对每格都强制应用风格（而非只在顶层声明一次）
  const stylePrefix = `[${style.positive}]`;
  const lines = cellPrompts.map((p, i) => `第${i + 1}格：${stylePrefix} ${p}`);
  const negative = [style.negative, COMMON_NEGATIVE].filter(Boolean).join(", ");
  return (
    `生成一张严格 3×3 等分的九宫格拼图，共 9 个独立画面，从左到右、从上到下编号 1-9。\n` +
    `【全局画面风格：${style.label}（${style.positive}）】所有格子必须统一采用此风格。\n` +
    `【硬性排版要求，必须严格遵守】\n` +
    `1. 9 个格子尺寸完全相同，精确等分整张图（每格各占宽 1/3、高 1/3）；\n` +
    `2. 格与格之间必须有清晰的纯白色分隔带，分隔带宽度约为画面宽度的 3%，横竖共 4 条，笔直贯穿、粗细均匀；\n` +
    `3. 每个画面的主体居中，四周留出安全边距，重要内容不要贴近格子边缘（边缘会被分隔带裁到）；\n` +
    `4. 不要任何文字、序号、水印、外层画框；只在 9 格之间保留白色分隔带。\n` +
    `每格都是完整独立的 ${ratio} 竖版画面，统一采用上述风格。\n` +
    `【避免出现以下内容】${negative}。\n` +
    `各格画面内容如下：\n${lines.join("\n")}`
  );
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

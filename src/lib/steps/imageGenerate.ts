import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { StepDef } from "./types";
import { generateGrid, sliceGrid } from "@/lib/providers/gptimage";
import { storyboardSchema, imagesSchema, type ImageItem } from "@/lib/domain";
import { imageStyle, DEFAULT_STYLE, COMMON_NEGATIVE, type ImageStyle } from "@/lib/styles";
import { z } from "zod";

/**
 * imageGenerate: 每个 scene 的 visual → 直接出图（不再经 LLM 改写）。
 *
 * 省钱方案：每 9 个 scene 拼成一张 3×3 网格图，一次出图再裁成 9 张
 * （出图调用 9→1）。比例可选，由 image-config.json / IMAGE_RATIO 配置。
 *
 * 画面风格：image-config.json 的 style 决定正向词(拼进 prompt)+负向词(避免描述)。
 * 默认油画印象(健康赛道)。gpt-image 无独立 negative 字段,负向词用"避免出现"拼入。
 *
 * 生成图带 scene/visual 标签 + prompt 落库（为将来素材库复用留语料）。
 */

// 画面风格 + 比例配置(工作台「⑦场景图」面板写入)
const imageConfigSchema = z.object({
  style: z.string().default(DEFAULT_STYLE),
  ratio: z.string().default("9:16"),
});

// 比例 → 网格图请求尺寸。整张网格图比例 = 单格比例（3×3 等比）。
// 跑通优先用保守档；清晰度不够后续调大。
const RATIO_GRID_SIZE: Record<string, string> = {
  "9:16": "1024x1536",
  "3:4": "1024x1536",
  "1:1": "1024x1024",
  "4:3": "1536x1024",
  "16:9": "1536x1024",
};
const DEFAULT_RATIO = "9:16";

export const imageGenerate: StepDef = {
  name: "imageGenerate",
  deps: ["assetSearch"],
  output: "images.json",
  run: async (ctx) => {
    const board = storyboardSchema.parse(await ctx.readJSON("storyboard.json"));
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

    const items: ImageItem[] = [];
    const batches = chunk(board.scenes, 9);
    const CONCURRENCY = Number(process.env.IMAGE_CONCURRENCY ?? "3");

    // 受控并发：每次最多同时发 CONCURRENCY 个 gpt-image 请求
    const resultMap = new Map<number, ImageItem[]>();
    for (let start = 0; start < batches.length; start += CONCURRENCY) {
      const group = batches.slice(start, start + CONCURRENCY);
      await Promise.all(group.map(async (batch, gi) => {
        const b = start + gi;
        const cellPrompts = batch.map((scene) => scene.visual);
        const gridPrompt = buildGridPrompt(cellPrompts, ratio, style);
        const gridRel = `images/_grids/grid_${b}.png`;
        const { cost } = await generateGrid(gridPrompt, join(ctx.taskDir, gridRel), gridSize, ctx.mode);
        ctx.reportCost(cost, { provider: "gptimage", grid: b, cells: batch.length });

        const cellRels = batch.map((s) => `images/${s.id}.png`);
        await sliceGrid(join(ctx.taskDir, gridRel), cellRels.map((r) => join(ctx.taskDir, r)), ctx.mode);

        const batchItems: ImageItem[] = [];
        for (let i = 0; i < batch.length; i++) {
          const scene = batch[i];
          await ctx.registerArtifact(cellRels[i], {
            fileType: "png", tag: scene.visual,
            meta: { sceneId: scene.id, prompt: cellPrompts[i], grid: gridRel, cell: i },
          });
          batchItems.push({ sceneId: scene.id, imagePath: cellRels[i], prompt: cellPrompts[i], visual: scene.visual, reused: false });
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
    ctx.log(`生图: ${items.length} 张 / ${batches.length} 张网格图（比例 ${ratio}）`);
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

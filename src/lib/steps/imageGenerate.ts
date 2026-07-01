import { join } from "node:path";
import { mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { StepDef, StepContext } from "./types";
import { generate, generateGrid, sliceGrid } from "@/lib/providers/gptimage";
import { rebindCells } from "@/lib/providers/doubaoVision";
import { withLimit, configureLimiter } from "@/lib/concurrency";
import { env } from "@/lib/providers/base";
import { directorSchema, imagesSchema, type ImageItem, type Beat, type Director } from "@/lib/domain";
import { imageStyle, DEFAULT_STYLE, COMMON_NEGATIVE, type ImageStyle } from "@/lib/styles";
import { z } from "zod";

/**
 * imageGenerate: 按导演的「画面节拍」出图——每拍一张图。
 *
 * 省钱方案:每 9 拍拼一张 3×3 网格图,一次出图再裁成 9 张。
 * 破法①(解九宫格乱序):切成"位置切片"后用豆包视觉归位,把每张图归到正确节拍,
 * 不再假设"第i格=第i拍"。可靠性:allSettled(一批失败不全崩)+ 失败批降级逐张出图 +
 * 签名幂等续跑(内容未变跳过重画)+ 手改保护 + 缺图校验 + 全部请求走全局调速器(跨任务限流防429)。
 */

// 画面风格 + 比例配置(工作台「场景图」面板写入)
const imageConfigSchema = z.object({
  style: z.string().default(DEFAULT_STYLE),
  ratio: z.string().default("9:16"),
});

// 比例 → 网格图请求尺寸。整张网格图比例 = 单格比例(3×3 等比)。
const RATIO_GRID_SIZE: Record<string, string> = {
  "9:16": "1024x1536",
  "3:4": "1024x1536",
  "1:1": "1024x1024",
  "4:3": "1536x1024",
  "16:9": "1536x1024",
};
const DEFAULT_RATIO = "9:16";

/** 把一个节拍展开成"单格出图描述":角色卡 + 景别 + 构图 */
export function beatToCellPrompt(beat: Beat, plan: Director): string {
  const parts: string[] = [];
  if (beat.use) {
    const id = beat.use.startsWith("cast:") ? beat.use.slice(5) : beat.use;
    const c = plan.cast.find((x) => x.id === id);
    if (c) parts.push(`人物:${c.bible}`);
  }
  if (beat.shotType) parts.push(`景别:${beat.shotType}`);
  parts.push(beat.composition);
  return parts.join("，");
}

/** 比例 → 单图请求尺寸字符串(与批量九宫格同档) */
export function ratioToSize(ratio: string): string {
  return RATIO_GRID_SIZE[ratio] ?? RATIO_GRID_SIZE[DEFAULT_RATIO];
}

/** 比例 → {width,height}(供单图 generate 用) */
function ratioToWH(ratio: string): { width: number; height: number } {
  const [w, h] = ratioToSize(ratio).split("x").map((n) => parseInt(n, 10));
  return { width: w || 1024, height: h || 1536 };
}

/** 单图重生成 prompt(修图用):同款风格正/负向词 + 节拍画面 + 用户修改意见(优先级最高)。 */
export function buildSinglePrompt(beat: Beat, plan: Director, style: ImageStyle, ratio: string, feedback?: string): string {
  const base = beatToCellPrompt(beat, plan);
  const negative = [style.negative, COMMON_NEGATIVE].filter(Boolean).join(", ");
  const fb = (feedback ?? "").trim();
  const tone = plan.visualTone ? `整片基调:${plan.visualTone}。` : "";
  return (
    `生成一张 ${ratio} 竖版画面。\n` +
    `【画面风格：${style.label}】${style.positive}。\n` +
    (tone ? tone + "\n" : "") +
    `【画面内容】${base}\n` +
    (fb ? `【务必按以下要求修改，与上文冲突时以此为准】${fb}\n` : "") +
    `【避免出现】${negative}。\n` +
    `不要任何文字、序号、水印、画框。`
  );
}

/** 内容签名:style+ratio+基调+节拍描述 变了才重画(幂等续跑用) */
function sigOf(style: string, ratio: string, tone: string, cellPrompt: string): string {
  return createHash("sha1").update([style, ratio, tone, cellPrompt].join("")).digest("hex").slice(0, 16);
}

interface GenOpts {
  plan: Director;
  style: ImageStyle;
  ratio: string;
  gridSize: string;
  globalTone: string;
  sigFor: (beat: Beat) => string;
}

export const imageGenerate: StepDef = {
  name: "imageGenerate",
  deps: ["director"],
  output: "images.json",
  run: async (ctx) => {
    const plan = directorSchema.parse(await ctx.readJSON("director.json"));
    await mkdir(join(ctx.taskDir, "images"), { recursive: true });
    await mkdir(join(ctx.taskDir, "images", "_grids"), { recursive: true });
    await mkdir(join(ctx.taskDir, "images", "_cells"), { recursive: true });

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
    const toneKey = plan.visualTone ?? ""; // 阶段4 加 setting 后并入签名

    // 全局调速器:跨任务限 gpt-image 并发(默认 2),防两任务同时生图打爆 429
    configureLimiter(
      "gptimage",
      Number(env("GPTIMAGE_CONCURRENCY", "2")),
      Number(env("GPTIMAGE_MIN_GAP_MS", "0"))
    );

    const sigFor = (beat: Beat) => sigOf(style.key, ratio, toneKey, beatToCellPrompt(beat, plan));
    const opts: GenOpts = { plan, style, ratio, gridSize, globalTone, sigFor };

    // 幂等续跑:载入已有 images.json(beatId → item)
    const prev = new Map<number, ImageItem>();
    try {
      const old = imagesSchema.parse(await ctx.readJSON("images.json"));
      for (const it of old.items) prev.set(it.beatId, it);
    } catch {
      /* 无历史 */
    }

    // 分类:复用(手改保留 或 签名未变且文件在) vs 需重画
    const reuseItems: ImageItem[] = [];
    const toGen: Beat[] = [];
    for (const beat of plan.beats) {
      const p = prev.get(beat.id);
      const fileOk = existsSync(join(ctx.taskDir, `images/${beat.id}.png`));
      const sig = sigFor(beat);
      if (p && fileOk && (p.manual === true || p.sig === sig)) {
        reuseItems.push({ ...p, sceneIds: beat.sceneIds }); // sceneIds 以最新导演为准(决定时长)
      } else {
        toGen.push(beat);
      }
    }
    if (reuseItems.length) ctx.log(`续跑复用 ${reuseItems.length} 张(签名未变/手改保留)`);

    // allSettled 分批生图:一批失败不拖垮其余;每批经全局调速器
    const batches = chunk(toGen, 9);
    const generated = new Map<number, ImageItem>();
    const results = await Promise.allSettled(
      batches.map((batch, b) => withLimit("gptimage", () => genGridBatch(ctx, batch, b, opts)))
    );

    const failedBatches: number[] = [];
    results.forEach((r, b) => {
      if (r.status === "fulfilled") for (const it of r.value) generated.set(it.beatId, it);
      else {
        failedBatches.push(b);
        ctx.log(`网格批 ${b} 失败:${r.reason instanceof Error ? r.reason.message : r.reason}`);
      }
    });

    // 失败批降级:逐张单图(独立请求,一张失败不影响其余),仍走调速器
    for (const b of failedBatches) {
      ctx.log(`网格批 ${b} 降级为逐张出图(${batches[b].length} 张)`);
      for (const beat of batches[b]) {
        try {
          const it = await withLimit("gptimage", () => genSingle(ctx, beat, opts));
          generated.set(beat.id, it);
        } catch (e) {
          ctx.log(`节拍 ${beat.id} 单图降级仍失败:${e instanceof Error ? e.message : e}`);
        }
      }
    }

    // 按导演 beat 顺序合并 + 缺图校验
    const items: ImageItem[] = [];
    const missing: number[] = [];
    for (const beat of plan.beats) {
      const it = generated.get(beat.id) ?? reuseItems.find((x) => x.beatId === beat.id);
      if (it) items.push(it);
      else missing.push(beat.id);
    }
    await ctx.writeJSON("images.json", imagesSchema.parse({ items }));

    if (missing.length) {
      const msg = `${missing.length} 个节拍缺图(beatId ${missing.join(",")}),已生成 ${items.length} 张。可重跑本步或在场景图面板单图重生成`;
      ctx.log(`⚠️ ${msg}`);
      return { ok: false, error: msg };
    }
    ctx.log(
      `生图: ${items.length} 张(节拍数) = ${batches.length} 网格 + ${reuseItems.length} 复用(比例 ${ratio})`
    );
    return { ok: true };
  },
};

/** 生成一批(≤9 拍)网格图 → 位置切片 → 豆包归位 → 放置到 beat 文件。返回本批 ImageItem[]。 */
async function genGridBatch(
  ctx: StepContext,
  batch: Beat[],
  b: number,
  o: GenOpts
): Promise<ImageItem[]> {
  const cellPrompts = batch.map((beat) => o.globalTone + beatToCellPrompt(beat, o.plan));
  const gridPrompt = buildGridPrompt(cellPrompts, o.ratio, o.style);
  const gridRel = `images/_grids/grid_${b}.png`;
  const { cost } = await generateGrid(gridPrompt, join(ctx.taskDir, gridRel), o.gridSize, ctx.mode);
  ctx.reportCost(cost, { provider: "gptimage", grid: b, cells: batch.length });

  // 切成"位置切片"临时文件(不直接写 beat 文件,先归位再放置)
  const cellTmpRels = batch.map((_, i) => `images/_cells/g${b}_${i}.png`);
  await sliceGrid(
    join(ctx.taskDir, gridRel),
    cellTmpRels.map((r) => join(ctx.taskDir, r)),
    ctx.mode
  );

  // 豆包视觉归位:beatToCell[j] = beat j 的内容实际所在的位置切片索引;null → 退回原位序
  const descriptions = batch.map((beat) => beat.composition);
  const beatToCell = await rebindCells(
    cellTmpRels.map((r) => join(ctx.taskDir, r)),
    descriptions,
    ctx.mode
  );
  if (beatToCell) ctx.log(`网格 ${b} 视觉归位: [${beatToCell.join(",")}]`);

  const out: ImageItem[] = [];
  for (let j = 0; j < batch.length; j++) {
    const beat = batch[j];
    const srcIdx = beatToCell ? beatToCell[j] : j;
    const rel = `images/${beat.id}.png`;
    const srcAbs = join(ctx.taskDir, cellTmpRels[srcIdx] ?? cellTmpRels[j]);
    await copyFile(srcAbs, join(ctx.taskDir, rel)).catch(() =>
      copyFile(join(ctx.taskDir, cellTmpRels[j]), join(ctx.taskDir, rel))
    );
    const prompt = cellPrompts[j];
    await ctx.registerArtifact(rel, {
      fileType: "png",
      tag: beat.composition,
      meta: { beatId: beat.id, sceneIds: beat.sceneIds, prompt, grid: gridRel, rebound: !!beatToCell },
    });
    out.push({
      beatId: beat.id,
      sceneIds: beat.sceneIds,
      imagePath: rel,
      prompt,
      visual: beat.composition,
      reused: false,
      sig: o.sigFor(beat),
    });
  }
  return out;
}

/** 降级:单张独立出图(网格批失败时逐拍兜底) */
async function genSingle(ctx: StepContext, beat: Beat, o: GenOpts): Promise<ImageItem> {
  const prompt = buildSinglePrompt(beat, o.plan, o.style, o.ratio);
  const rel = `images/${beat.id}.png`;
  const { cost } = await generate(prompt, join(ctx.taskDir, rel), ratioToWH(o.ratio), ctx.mode);
  ctx.reportCost(cost, { provider: "gptimage", single: beat.id });
  await ctx.registerArtifact(rel, {
    fileType: "png",
    tag: beat.composition,
    meta: { beatId: beat.id, sceneIds: beat.sceneIds, prompt, single: true },
  });
  return {
    beatId: beat.id,
    sceneIds: beat.sceneIds,
    imagePath: rel,
    prompt,
    visual: beat.composition,
    reused: false,
    sig: o.sigFor(beat),
  };
}

/** 把 ≤9 条单格 prompt 拼成一个 3×3 网格出图 prompt(含风格正/负向词) */
function buildGridPrompt(cellPrompts: string[], ratio: string, style: ImageStyle): string {
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

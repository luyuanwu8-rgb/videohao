import { NextRequest, NextResponse } from "next/server";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { steps } from "@/db/schema";
import { taskDir, isTaskBusy } from "@/lib/pipeline";
import { directorSchema, imagesSchema } from "@/lib/domain";
import { imageStyle, DEFAULT_STYLE } from "@/lib/styles";
import { buildSinglePrompt, ratioToSize } from "@/lib/steps/imageGenerate";
import { generate } from "@/lib/providers/gptimage";
import { withLimit, configureLimiter } from "@/lib/concurrency";
import { env } from "@/lib/providers/base";
import { ensureConfigLoaded } from "@/lib/config-cache";

export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/[id]/image/regenerate  body: { beatId, feedback?, style? }
 *
 * 单图重生成(阶段2):针对某一拍单独重画,支持用户反馈(优先级最高)与临时换风格。
 * 复用阶段1 的 buildSinglePrompt + generate + 全局调速器;标记 meta.manual=true,
 * 使整批重跑时保留用户手改;因图变了,重置 render 为 pending(成片需重渲)。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const beatId = Number(body.beatId);
  const feedback = typeof body.feedback === "string" ? body.feedback : "";
  if (!Number.isInteger(beatId)) {
    return NextResponse.json({ ok: false, error: "beatId 必填(整数)" }, { status: 400 });
  }
  if (isTaskBusy(id)) {
    return NextResponse.json({ ok: false, error: "任务正在处理中，请稍候再试" }, { status: 409 });
  }

  await ensureConfigLoaded();
  const dir = taskDir(id);

  let plan;
  try {
    plan = directorSchema.parse(JSON.parse(await readFile(join(dir, "director.json"), "utf-8")));
  } catch {
    return NextResponse.json({ ok: false, error: "导演方案缺失，无法重生成" }, { status: 400 });
  }
  const beat = plan.beats.find((b) => b.id === beatId);
  if (!beat) {
    return NextResponse.json({ ok: false, error: `未找到节拍 ${beatId}` }, { status: 404 });
  }

  // 读风格/比例(body.style 可临时覆盖)
  let styleKey = DEFAULT_STYLE;
  let ratio = "9:16";
  try {
    const c = JSON.parse(await readFile(join(dir, "image-config.json"), "utf-8")) as { style?: string; ratio?: string };
    styleKey = c.style ?? DEFAULT_STYLE;
    ratio = c.ratio ?? "9:16";
  } catch {
    /* 用默认 */
  }
  if (typeof body.style === "string" && body.style) styleKey = body.style;
  const style = imageStyle(styleKey);

  const prompt = buildSinglePrompt(beat, plan, style, ratio, feedback);
  const rel = `images/${beatId}.png`;
  const [w, h] = ratioToSize(ratio).split("x").map((n) => parseInt(n, 10));
  const mode = process.env.PIPELINE_MODE === "real" ? "real" : "mock";

  configureLimiter("gptimage", Number(env("GPTIMAGE_CONCURRENCY", "2")), Number(env("GPTIMAGE_MIN_GAP_MS", "0")));
  try {
    await mkdir(join(dir, "images"), { recursive: true }); // 自给自足:确保目录在
    await withLimit("gptimage", () => generate(prompt, join(dir, rel), { width: w || 1024, height: h || 1536 }, mode));
  } catch (e) {
    return NextResponse.json({ ok: false, error: `重生成失败: ${e instanceof Error ? e.message : e}` }, { status: 500 });
  }

  // 更新 images.json:该项标 manual、更新 prompt/visual/sig
  try {
    const imgs = imagesSchema.parse(JSON.parse(await readFile(join(dir, "images.json"), "utf-8")));
    const it = imgs.items.find((x) => x.beatId === beatId);
    if (it) {
      it.prompt = prompt;
      it.visual = beat.composition;
      it.manual = true;
      it.sig = createHash("sha1").update("manual:" + prompt).digest("hex").slice(0, 16);
      await writeFile(join(dir, "images.json"), JSON.stringify(imgs, null, 2), "utf-8");
    }
  } catch {
    /* images.json 不存在则忽略(单图仍已落盘) */
  }

  // 图变了,成片需重渲:重置 render 为 pending
  await db
    .update(steps)
    .set({ status: "pending", startedAt: null, endedAt: null })
    .where(and(eq(steps.taskId, id), eq(steps.name, "render")));

  return NextResponse.json({ ok: true, imagePath: rel, prompt });
}

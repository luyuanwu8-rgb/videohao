import { NextRequest, NextResponse } from "next/server";
import { eq, asc } from "drizzle-orm";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/db/client";
import { tasks, steps, artifacts } from "@/db/schema";
import { CHECKPOINTS, lastStepOf } from "@/lib/checkpoints";

export const dynamic = "force-dynamic";

/**
 * 计算生图/渲染的真实进度(从磁盘数文件,非装饰性假进度)。
 * - 生图:images/ 下已出图数 / 导演 beats 总数。
 * - 渲染:最新 ffwork-* 目录里已渲 clip 数 / 总数;全渲完则进入"拼接·烧字幕"终编阶段。
 * 仅在对应步骤 running 时计算,避免无谓磁盘 IO。
 */
async function computeProgress(
  id: string,
  statusByStep: Map<string, string>
): Promise<{ imageGen?: { done: number; total: number }; render?: { phase: string; done: number; total: number } }> {
  const imgRunning = statusByStep.get("imageGenerate") === "running";
  const renderRunning = statusByStep.get("render") === "running";
  if (!imgRunning && !renderRunning) return {};

  const { taskDir } = await import("@/lib/pipeline");
  const dir = taskDir(id);
  let total = 0;
  try {
    const d = JSON.parse(await readFile(join(dir, "director.json"), "utf-8"));
    total = Array.isArray(d.beats) ? d.beats.length : 0;
  } catch { /* 导演方案缺失 */ }
  if (total === 0) return {};

  const out: { imageGen?: { done: number; total: number }; render?: { phase: string; done: number; total: number } } = {};

  if (imgRunning) {
    const files = await readdir(join(dir, "images")).catch(() => [] as string[]);
    const done = files.filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f)).length; // 顶层成图(网格在 _grids 子目录,不计)
    out.imageGen = { done: Math.min(done, total), total };
  }

  if (renderRunning) {
    const rdir = join(dir, "renders");
    let latest = ""; let latestMs = -1;
    const ents = await readdir(rdir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
    for (const e of ents) {
      if (e.isDirectory() && /^ffwork-/.test(e.name)) {
        const ms = (await stat(join(rdir, e.name)).catch(() => null))?.mtimeMs ?? -1;
        if (ms > latestMs) { latestMs = ms; latest = join(rdir, e.name); }
      }
    }
    if (!latest) {
      out.render = { phase: "准备中", done: 0, total };
    } else {
      const cf = await readdir(latest).catch(() => [] as string[]);
      const clips = cf.filter((f) => /^clip_\d+\.mp4$/.test(f)).length;
      const phase = clips >= total ? "拼接·烧字幕合成中(最后一步)" : "分段渲染中";
      out.render = { phase, done: Math.min(clips, total), total };
    }
  }
  return out;
}

/** GET /api/tasks/[id] — 任务详情：task + steps + artifacts + 实时进度 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const task = (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
  if (!task) {
    return NextResponse.json({ ok: false, error: "task not found" }, { status: 404 });
  }
  const stepRows = await db
    .select()
    .from(steps)
    .where(eq(steps.taskId, id))
    .orderBy(asc(steps.id));
  const artifactRows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, id))
    .orderBy(asc(artifacts.createdAt));
  const totalCost = stepRows.reduce((sum, s) => sum + (s.cost ?? 0), 0);

  // 检查点视图：把内部 step 状态聚合到 9 个用户可见检查点上。
  // 某检查点状态 = 其名下最后一个内部 step 的状态；纯配置点(无 step)看其 editable 产物所属上游。
  const statusByStep = new Map(stepRows.map((s) => [s.name, s.status]));
  const checkpoints = CHECKPOINTS.map((cp) => {
    const last = lastStepOf(cp.key);
    // 纯配置点取其内部 step 之前所有 step 是否完成来判定可进入
    const allDone = cp.steps.every((n) => statusByStep.get(n) === "completed");
    const anyFailed = cp.steps.some((n) => statusByStep.get(n) === "failed");
    const anyRunning = cp.steps.some((n) => statusByStep.get(n) === "running");
    let status: string;
    if (cp.steps.length === 0) status = "config"; // 纯配置点
    else if (anyFailed) status = "failed";
    else if (anyRunning) status = "running";
    else if (allDone) status = "completed";
    else status = "pending";
    return {
      key: cp.key,
      label: cp.label,
      steps: cp.steps,
      editable: cp.editable ?? null,
      lastStep: last ?? null,
      status,
    };
  });

  const progress = await computeProgress(id, statusByStep);

  return NextResponse.json({
    ok: true,
    task,
    steps: stepRows,
    artifacts: artifactRows,
    checkpoints,
    totalCost,
    progress,
  });
}

/** DELETE /api/tasks/[id] — 删除任务:DB 记录(cascade) + 磁盘目录。
 * 安全护栏:①ID 必须合法 UUID ②运行中/排队中禁删 ③路径白名单(见 cleanup.safeTaskDir)。 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { isValidTaskId, deleteTaskFiles } = await import("@/lib/cleanup");
  if (!isValidTaskId(id)) {
    return NextResponse.json({ ok: false, error: "非法任务ID,已拒绝" }, { status: 400 });
  }
  const task = (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
  if (!task) return NextResponse.json({ ok: false, error: "task not found" }, { status: 404 });

  // 仅当任务"真正在跑"(本进程内存锁/队列)才禁删;不依赖可能过期的 DB 状态(避免僵尸状态永远删不掉)
  const { isTaskBusy } = await import("@/lib/pipeline");
  const { queuePosition } = await import("@/lib/renderQueue");
  if (isTaskBusy(id) || queuePosition(id) >= 0) {
    return NextResponse.json(
      { ok: false, error: "任务正在运行或排队中,请先暂停或等待完成再删除" },
      { status: 409 }
    );
  }

  // 先删磁盘(路径安全校验;非法/越界会抛错则不动 DB)。文件被占用(如视频正在预览)给出友好提示,可关闭后重试
  let freedBytes = 0;
  try {
    ({ bytes: freedBytes } = await deleteTaskFiles(id));
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "";
    const locked = ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(code);
    return NextResponse.json(
      {
        ok: false,
        error: locked
          ? "该任务的视频文件正被占用(可能正在预览播放),请关闭视频预览后重试"
          : `删除文件失败: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: locked ? 409 : 500 }
    );
  }
  await db.delete(tasks).where(eq(tasks.id, id));
  return NextResponse.json({ ok: true, freedBytes });
}

import { NextRequest, NextResponse } from "next/server";
import { eq, asc } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks, steps, artifacts } from "@/db/schema";
import { CHECKPOINTS, lastStepOf } from "@/lib/checkpoints";

export const dynamic = "force-dynamic";

/** GET /api/tasks/[id] — 任务详情：task + steps + artifacts */
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

  return NextResponse.json({
    ok: true,
    task,
    steps: stepRows,
    artifacts: artifactRows,
    checkpoints,
    totalCost,
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

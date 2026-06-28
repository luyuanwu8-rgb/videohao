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

/** DELETE /api/tasks/[id] — 删除任务：DB 记录(cascade) + 磁盘目录 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await db.delete(tasks).where(eq(tasks.id, id)); // cascade 删 steps + artifacts
  const { taskDir } = await import("@/lib/pipeline");
  const { rm } = await import("node:fs/promises");
  await rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  return NextResponse.json({ ok: true });
}

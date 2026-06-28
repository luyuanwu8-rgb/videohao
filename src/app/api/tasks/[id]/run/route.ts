import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { steps } from "@/db/schema";
import { runStep } from "@/lib/pipeline";
import { PIPELINE_DEPS, type StepName } from "@/lib/steps/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/[id]/run  body: { step?: StepName }
 *
 * 重跑指定 step。会先把该 step 及其所有下游重置为 pending（因为产物已失效），
 * 然后只重跑该 step（下游由用户按需逐个触发，或前端连跑）。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const step = body.step as StepName | undefined;
  if (!step) {
    return NextResponse.json({ ok: false, error: "step is required" }, { status: 400 });
  }

  // 重置该 step 及其下游
  const downstream = collectDownstream(step);
  for (const name of [step, ...downstream]) {
    await db
      .update(steps)
      .set({ status: "pending", error: null, startedAt: null, endedAt: null })
      .where(and(eq(steps.taskId, id), eq(steps.name, name)));
  }

  const result = await runStep(id, step);
  return NextResponse.json({ ok: result.ok, error: result.error, reset: downstream });
}

/** 收集某 step 的所有下游（递归） */
function collectDownstream(step: StepName): StepName[] {
  const out = new Set<StepName>();
  const stack = [step];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const [name, deps] of Object.entries(PIPELINE_DEPS) as [StepName, StepName[]][]) {
      if (deps.includes(cur) && !out.has(name)) {
        out.add(name);
        stack.push(name);
      }
    }
  }
  return [...out];
}

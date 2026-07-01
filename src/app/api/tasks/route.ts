import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { createTask, advanceTo } from "@/lib/pipeline";
import { enqueue, ensureQueueRecovered, queueSnapshot } from "@/lib/renderQueue";
import { findCheckpoint, CHECKPOINTS } from "@/lib/checkpoints";

export const dynamic = "force-dynamic";

/** GET /api/tasks — 任务列表(+ 队列快照)。顺带触发队列自愈(幂等,仅首次扫库) */
export async function GET() {
  await ensureQueueRecovered();
  const rows = await db.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(100);
  return NextResponse.json({ ok: true, tasks: rows, queue: queueSnapshot() });
}

/** 按自动化策略后台推进:stopAt=final 走"跑到 style 再入串行队列渲染";否则跑到 stopAt 停下等审阅 */
function scheduleAutoRun(taskId: string, stopAt: string) {
  const finalKey = CHECKPOINTS[CHECKPOINTS.length - 1].key;
  if (stopAt === finalKey) {
    // 全自动:先跑到成片前(style),再入队串行渲染(不绕过队列)
    const beforeFinal = CHECKPOINTS[CHECKPOINTS.length - 2].key;
    void advanceTo(taskId, beforeFinal)
      .then((r) => { if (r.ok) return enqueue(taskId); })
      .catch(() => {});
  } else {
    void advanceTo(taskId, stopAt).catch(() => {});
  }
}

/** POST /api/tasks — 新建任务。
 *  - 传 sourceUrl：抖音链接模式；传 script：自带文案模式。
 *  - presets：快速制作配置中心一次预设的配音/画面/运镜/人物配置。
 *  - autoRun.stopAt：自动跑到哪个检查点停(默认:link→parse, script→storyboard);"final"=全自动到成片。 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const sourceUrl = String(body.sourceUrl ?? "").trim();
  const script = String(body.script ?? "").trim();
  const track = body.track ? String(body.track) : undefined;
  const presets = body.presets;
  const stopAtRaw = typeof body.autoRun?.stopAt === "string" ? body.autoRun.stopAt : "";
  const stopAt = findCheckpoint(stopAtRaw) ? stopAtRaw : "";

  if (script) {
    const task = await createTask({ script, track, presets });
    scheduleAutoRun(task.id, stopAt || "storyboard");
    return NextResponse.json({ ok: true, taskId: task.id });
  }

  if (!sourceUrl) {
    return NextResponse.json(
      { ok: false, error: "需要 sourceUrl(抖音链接) 或 script(自带文案)" },
      { status: 400 }
    );
  }
  const task = await createTask({ sourceUrl, track, presets });
  scheduleAutoRun(task.id, stopAt || "parse");
  return NextResponse.json({ ok: true, taskId: task.id });
}

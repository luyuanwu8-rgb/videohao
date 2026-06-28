import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { createTask, advanceTo } from "@/lib/pipeline";
import { ensureQueueRecovered, queueSnapshot } from "@/lib/renderQueue";

export const dynamic = "force-dynamic";

/** GET /api/tasks — 任务列表(+ 队列快照)。顺带触发队列自愈(幂等,仅首次扫库) */
export async function GET() {
  await ensureQueueRecovered();
  const rows = await db.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(100);
  return NextResponse.json({ ok: true, tasks: rows, queue: queueSnapshot() });
}

/** POST /api/tasks — 粘贴抖音链接新建任务，后台跑到第一个检查点(解析) */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const sourceUrl = String(body.sourceUrl ?? "").trim();
  if (!sourceUrl) {
    return NextResponse.json({ ok: false, error: "sourceUrl is required" }, { status: 400 });
  }
  const track = body.track ? String(body.track) : undefined;
  const task = await createTask({ sourceUrl, track });

  // 分步模式:只跑到第一个检查点(解析),停下等用户审阅
  void advanceTo(task.id, "parse").catch(() => {});

  return NextResponse.json({ ok: true, taskId: task.id });
}

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

/** POST /api/tasks — 新建任务。
 *  - 传 sourceUrl：抖音链接模式，跑到解析检查点。
 *  - 传 script：自带文案模式，跳过解析/ASR/改写，直接到分镜检查点。 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const sourceUrl = String(body.sourceUrl ?? "").trim();
  const script = String(body.script ?? "").trim();
  const track = body.track ? String(body.track) : undefined;

  if (script) {
    // 自带文案：前4步已在 createTask 标记完成，直接推进到分镜
    const task = await createTask({ script, track });
    void advanceTo(task.id, "storyboard").catch(() => {});
    return NextResponse.json({ ok: true, taskId: task.id });
  }

  if (!sourceUrl) {
    return NextResponse.json(
      { ok: false, error: "需要 sourceUrl(抖音链接) 或 script(自带文案)" },
      { status: 400 }
    );
  }
  const task = await createTask({ sourceUrl, track });
  // 分步模式:只跑到第一个检查点(解析),停下等用户审阅
  void advanceTo(task.id, "parse").catch(() => {});
  return NextResponse.json({ ok: true, taskId: task.id });
}

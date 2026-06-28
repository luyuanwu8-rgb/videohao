import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";

export const dynamic = "force-dynamic";

const now = () => Math.floor(Date.now() / 1000);

/** POST /api/tasks/[id]/pause — 切换暂停/恢复。running→paused，paused→running */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!t) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

  if (t.status === "running") {
    await db.update(tasks).set({ status: "paused", updatedAt: now() }).where(eq(tasks.id, id));
    return NextResponse.json({ ok: true, status: "paused" });
  }
  if (t.status === "paused") {
    await db.update(tasks).set({ status: "running", updatedAt: now() }).where(eq(tasks.id, id));
    // 恢复：重新推进流水线（后台继续跑）
    const { advanceTo } = await import("@/lib/pipeline");
    void advanceTo(id, "final").catch(() => {});
    return NextResponse.json({ ok: true, status: "running" });
  }
  return NextResponse.json({ ok: false, error: `cannot pause status=${t.status}` }, { status: 400 });
}

import { NextRequest, NextResponse } from "next/server";
import { advanceTo } from "@/lib/pipeline";
import { findCheckpoint } from "@/lib/checkpoints";

export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/[id]/advance  body: { checkpoint: string }
 *
 * "确认,下一步":推进到指定检查点(跑其名下内部 step,已完成则幂等跳过)。
 * 纯配置检查点(steps 为空)直接返回 ok。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const checkpoint = String(body.checkpoint ?? "");
  if (!findCheckpoint(checkpoint)) {
    return NextResponse.json({ ok: false, error: "unknown checkpoint" }, { status: 400 });
  }

  // 后台跑,不阻塞;前端轮询 detail 看进度
  void advanceTo(id, checkpoint).catch(() => {});
  return NextResponse.json({ ok: true });
}

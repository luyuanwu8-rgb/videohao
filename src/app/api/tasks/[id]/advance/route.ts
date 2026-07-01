import { NextRequest, NextResponse } from "next/server";
import { advanceTo } from "@/lib/pipeline";
import { enqueue } from "@/lib/renderQueue";
import { findCheckpoint, CHECKPOINTS } from "@/lib/checkpoints";

export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/[id]/advance  body: { checkpoint: string }
 *
 * "确认,下一步":推进到指定检查点(跑其名下内部 step,已完成则幂等跳过)。
 * 纯配置检查点(steps 为空)直接返回 ok。
 * 注意:目标为最终"成片"检查点时,改走串行渲染队列(不直接 advanceTo,避免并发渲染 —— A1/F4)。
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

  // 成片检查点:唯一入口是串行队列,杜绝并发渲染互删帧
  const finalKey = CHECKPOINTS[CHECKPOINTS.length - 1].key;
  if (checkpoint === finalKey) {
    const { position } = await enqueue(id);
    return NextResponse.json({ ok: true, queued: true, position });
  }

  // 其余检查点:后台跑,不阻塞;前端轮询 detail 看进度
  void advanceTo(id, checkpoint).catch(() => {});
  return NextResponse.json({ ok: true });
}

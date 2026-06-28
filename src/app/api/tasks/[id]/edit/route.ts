import { NextRequest, NextResponse } from "next/server";
import { editArtifact } from "@/lib/pipeline";
import { findCheckpoint } from "@/lib/checkpoints";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/tasks/[id]/edit  body: { checkpoint: string, data: unknown }
 *
 * 保存某检查点编辑后的产物 json,并把下游 step 重置为 pending(需重跑)。
 * 仅允许编辑 checkpoint 声明的 editable 产物。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const checkpointKey = String(body.checkpoint ?? "");
  const cp = findCheckpoint(checkpointKey);
  if (!cp || !cp.editable) {
    return NextResponse.json(
      { ok: false, error: "checkpoint not editable" },
      { status: 400 }
    );
  }
  if (body.data === undefined) {
    return NextResponse.json({ ok: false, error: "data is required" }, { status: 400 });
  }

  await editArtifact(id, cp.editable, body.data, cp.invalidatesFrom);
  return NextResponse.json({ ok: true });
}

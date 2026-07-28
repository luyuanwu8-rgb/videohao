import { NextRequest, NextResponse } from "next/server";
import {
  readPublishKit,
  savePublishKitEdits,
  triggerPublishKit,
  type PublishKitAction,
} from "@/lib/publishKit";
import { isValidTaskId } from "@/lib/cleanup";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidTaskId(id)) {
    return NextResponse.json({ ok: false, error: "非法任务ID" }, { status: 400 });
  }
  const kit = await readPublishKit(id);
  return NextResponse.json({ ok: true, kit });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidTaskId(id)) {
    return NextResponse.json({ ok: false, error: "非法任务ID" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const action: PublishKitAction =
    body.action === "text" || body.action === "cover" ? body.action : "all";
  const { started } = triggerPublishKit(id, action);
  return NextResponse.json({
    ok: true,
    started,
    kit: await readPublishKit(id),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidTaskId(id)) {
    return NextResponse.json({ ok: false, error: "非法任务ID" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  try {
    const kit = await savePublishKitEdits(id, {
      title: typeof body.title === "string" ? body.title : undefined,
      subtitle: typeof body.subtitle === "string" ? body.subtitle : undefined,
      caption: typeof body.caption === "string" ? body.caption : undefined,
      tags: Array.isArray(body.tags)
        ? body.tags.filter((item: unknown): item is string => typeof item === "string")
        : undefined,
      conversionComment:
        typeof body.conversionComment === "string"
          ? body.conversionComment
          : undefined,
      purchaseComment:
        typeof body.purchaseComment === "string"
          ? body.purchaseComment
          : undefined,
      fullScript: typeof body.fullScript === "string" ? body.fullScript : undefined,
    });
    return NextResponse.json({ ok: true, kit });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }
}

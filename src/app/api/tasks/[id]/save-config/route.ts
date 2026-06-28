import { NextRequest, NextResponse } from "next/server";
import { taskDir } from "@/lib/pipeline";
import { join, dirname } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";

export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/[id]/save-config  body: { file: string, data: unknown }
 *
 * 软保存：把 data 写入任务目录下的 file，不重置任何步骤状态。
 * 用于前端「用户改了选项立即持久化」（音色/动效/声明），避免刷新丢失选择。
 * 不影响下游 step 状态 —— 用户真正点「生成」时 saveEdit 才会失效下游。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const file = String(body.file ?? "");
  if (!file || file.includes("..")) {
    return NextResponse.json({ ok: false, error: "invalid file" }, { status: 400 });
  }
  const abs = join(taskDir(id), file);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(body.data, null, 2), "utf-8");
  return NextResponse.json({ ok: true });
}

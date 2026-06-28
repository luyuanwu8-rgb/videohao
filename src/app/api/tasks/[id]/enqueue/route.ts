import { NextRequest, NextResponse } from "next/server";
import { enqueue } from "@/lib/renderQueue";

export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/[id]/enqueue
 *
 * 把任务加入成片渲染队列(串行 worker 会依次跑 subtitleAlign→timelineBuild→render)。
 * 前置:1-7 步(配音/生图/风格配置)应已就绪;此处不强校验,worker 内 advanceTo 会按
 * 依赖跑缺失步,但正常用法是用户在工作台确认完才入队。
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { position } = await enqueue(id);
  return NextResponse.json({ ok: true, position });
}

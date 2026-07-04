import { NextResponse } from "next/server";
import { sweepWorkDirs } from "@/lib/cleanup";

export const dynamic = "force-dynamic";

/**
 * POST /api/cleanup — 手动清理渲染临时"孤儿工作目录"(ffwork- / work- 前缀)。
 * 只删废料子目录,成品/图片/json 不碰;正在渲染的目录受活动登记+年龄阈值双重保护。
 */
export async function POST() {
  const { dirs, bytes } = await sweepWorkDirs({ minAgeMs: 2 * 60 * 1000 });
  return NextResponse.json({ ok: true, dirs, bytes });
}

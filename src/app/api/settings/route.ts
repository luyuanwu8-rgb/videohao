import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { apiConfigs } from "@/db/schema";
import { refreshConfigCache } from "@/lib/config-cache";

export const dynamic = "force-dynamic";

/** 密钥脱敏:只露首尾各2-3字符 */
function mask(v: string): string {
  if (!v) return "";
  if (v.length <= 6) return "***";
  return v.slice(0, 3) + "***" + v.slice(-2);
}

/** GET /api/settings — 列出所有 API 配置(密钥脱敏,带 hasValue 标记) */
export async function GET() {
  const rows = await db.select().from(apiConfigs);
  rows.sort((a, b) => (a.provider + a.key).localeCompare(b.provider + b.key));
  const out = rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    key: r.key,
    description: r.description,
    isSecret: r.isSecret === 1,
    hasValue: !!r.value,
    // 密钥只回脱敏值;非密钥回真实值(便于编辑域名/模型名)
    value: r.isSecret === 1 ? mask(r.value) : r.value,
  }));
  return NextResponse.json({ ok: true, configs: out });
}

/** PATCH /api/settings — 保存某 key 的值,刷新缓存。空值=不改(避免误清密钥) */
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const key = String(body.key ?? "");
  const value = body.value;
  if (!key) {
    return NextResponse.json({ ok: false, error: "key required" }, { status: 400 });
  }
  const row = (await db.select().from(apiConfigs).where(eq(apiConfigs.key, key)))[0];
  if (!row) {
    return NextResponse.json({ ok: false, error: "unknown key" }, { status: 404 });
  }
  // value 为空字符串/undefined 时:密钥项跳过(不清空),非密钥项允许清空
  if ((value === undefined || value === "") && row.isSecret === 1) {
    return NextResponse.json({ ok: true, skipped: true });
  }
  await db
    .update(apiConfigs)
    .set({ value: String(value ?? ""), updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(apiConfigs.id, row.id));
  await refreshConfigCache(); // 立即生效
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { promptsConfig } from "@/db/schema";
import { PROMPT_DEFAULTS } from "@/lib/prompt-defaults";

export const dynamic = "force-dynamic";

/** GET /api/prompts — 列出所有提示词(库为准) */
export async function GET() {
  const rows = await db.select().from(promptsConfig);
  // 按 step 分组顺序稳定
  rows.sort((a, b) => (a.step + a.track).localeCompare(b.step + b.track));
  return NextResponse.json({ ok: true, prompts: rows });
}

/** PATCH /api/prompts — 保存编辑(按 step+track upsert) */
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const step = String(body.step ?? "");
  const track = String(body.track ?? "");
  const system = String(body.system ?? "");
  const buildTemplate = String(body.buildTemplate ?? "");
  if (!step || !track) {
    return NextResponse.json({ ok: false, error: "step/track required" }, { status: 400 });
  }
  const now = Math.floor(Date.now() / 1000);
  const existing = (
    await db.select().from(promptsConfig).where(and(eq(promptsConfig.step, step), eq(promptsConfig.track, track)))
  )[0];
  if (existing) {
    await db
      .update(promptsConfig)
      .set({ system, buildTemplate, version: existing.version + 1, updatedAt: now })
      .where(eq(promptsConfig.id, existing.id));
  } else {
    await db.insert(promptsConfig).values({
      id: randomUUID(), step, track, system, buildTemplate, updatedAt: now,
    });
  }
  return NextResponse.json({ ok: true });
}

/** DELETE /api/prompts?step=xx&track=xx — 删除一条提示词 */
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const step = searchParams.get("step") ?? "";
  const track = searchParams.get("track") ?? "";
  if (!step || !track) return NextResponse.json({ ok: false, error: "step/track required" }, { status: 400 });
  await db.delete(promptsConfig).where(and(eq(promptsConfig.step, step), eq(promptsConfig.track, track)));
  return NextResponse.json({ ok: true });
}
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.action !== "restore") {
    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  }
  const step = String(body.step ?? "");
  const track = String(body.track ?? "");
  const def = PROMPT_DEFAULTS.find((d) => d.step === step && d.track === track);
  if (!def) {
    return NextResponse.json({ ok: false, error: "no factory default for this prompt" }, { status: 404 });
  }
  const now = Math.floor(Date.now() / 1000);
  const existing = (
    await db.select().from(promptsConfig).where(and(eq(promptsConfig.step, step), eq(promptsConfig.track, track)))
  )[0];
  if (existing) {
    await db
      .update(promptsConfig)
      .set({ system: def.system, buildTemplate: def.buildTemplate, updatedAt: now })
      .where(eq(promptsConfig.id, existing.id));
  }
  return NextResponse.json({ ok: true, system: def.system, buildTemplate: def.buildTemplate });
}

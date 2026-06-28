import { NextRequest, NextResponse } from "next/server";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { synthesize } from "@/lib/providers/stepfun";
import { synthesizeVolc } from "@/lib/providers/volcengine";

export const dynamic = "force-dynamic";

const SAMPLE = "很多人觉得睡前饿肚子是亏待自己，其实刚好相反。";

/**
 * POST /api/tts/preview  body: { provider, voice, speed, text? }
 * 用样例句合成一小段，直接返回 mp3 字节供面板试听。不落任务目录。
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const provider = body.provider === "stepfun" ? "stepfun" : "volcengine";
  const voice = String(body.voice ?? "");
  const speed = typeof body.speed === "number" ? body.speed : 1.0;
  const text = (body.text ? String(body.text) : SAMPLE).slice(0, 60);
  if (!voice) {
    return NextResponse.json({ ok: false, error: "voice required" }, { status: 400 });
  }

  const dir = join(tmpdir(), "tts-preview");
  await mkdir(dir, { recursive: true });
  const dest = join(dir, `${randomUUID()}.mp3`);
  try {
    if (provider === "stepfun") {
      await synthesize(text, dest, "real", { voice, speed });
    } else {
      await synthesizeVolc(text, dest, "real", { voice, speed });
    }
    const buf = await readFile(dest);
    return new NextResponse(buf, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  } finally {
    await rm(dest, { force: true }).catch(() => {});
  }
}

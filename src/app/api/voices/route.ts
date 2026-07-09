import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { DEFAULT_CUSTOM_VOICES, isValidCustomVoice, normalizeCustomVoice, type CustomVoice } from "@/lib/customVoices";

/**
 * GET  /api/voices — 读自定义音色清单(文件缺失返回预置)
 * PATCH /api/voices — 覆盖保存整个清单(前端增删后提交全量),校验 + 去重(同 provider 下 id 唯一)
 */

const DATA_ROOT = process.env.DATA_ROOT ?? "./data";
const VOICES_PATH = join(DATA_ROOT, "custom-voices.json");

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const raw = await readFile(VOICES_PATH, "utf-8");
    const arr = JSON.parse(raw);
    return NextResponse.json({ ok: true, voices: Array.isArray(arr) ? arr.filter(isValidCustomVoice) : DEFAULT_CUSTOM_VOICES });
  } catch {
    return NextResponse.json({ ok: true, voices: DEFAULT_CUSTOM_VOICES });
  }
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({ voices: [] }));
  if (!Array.isArray(body.voices)) {
    return NextResponse.json({ ok: false, error: "voices must be array" }, { status: 400 });
  }
  // 校验 + 规范化 + 同 provider 下 voice_id 去重(后者覆盖前者)
  const seen = new Set<string>();
  const clean: CustomVoice[] = [];
  for (const v of body.voices) {
    if (!isValidCustomVoice(v)) continue;
    const n = normalizeCustomVoice(v);
    const key = `${n.provider}:${n.id}`;
    if (seen.has(key)) {
      const i = clean.findIndex((x) => `${x.provider}:${x.id}` === key);
      if (i >= 0) clean[i] = n; // 去重:同 id 保留最后一条
      continue;
    }
    seen.add(key);
    clean.push(n);
  }
  await mkdir(dirname(VOICES_PATH), { recursive: true });
  await writeFile(VOICES_PATH, JSON.stringify(clean, null, 2), "utf-8");
  return NextResponse.json({ ok: true, voices: clean });
}

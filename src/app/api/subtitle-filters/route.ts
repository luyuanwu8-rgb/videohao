import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const DATA_ROOT = process.env.DATA_ROOT ?? "./data";
const FILTERS_PATH = join(DATA_ROOT, "subtitle-filters.json");

const DEFAULT_FILTERS = [
  { from: "治疗", to: "ZL" }, { from: "治愈", to: "ZY" }, { from: "根治", to: "GZ" },
  { from: "化疗", to: "HL" }, { from: "放疗", to: "FL" }, { from: "手术", to: "SS" },
  { from: "注射", to: "ZS" }, { from: "输液", to: "SY" }, { from: "药物", to: "YW" },
  { from: "药品", to: "YP" }, { from: "中药", to: "ZhY" }, { from: "西药", to: "XiY" },
  { from: "消炎", to: "XY" }, { from: "抗炎", to: "KY" }, { from: "排毒", to: "PD" },
  { from: "解毒", to: "JD" }, { from: "活血", to: "HX" }, { from: "补血", to: "BX" },
  { from: "补肾", to: "BS" }, { from: "补药", to: "BY" }, { from: "疗效", to: "LX" },
  { from: "血管", to: "x管" }, { from: "细胞", to: "XB" }, { from: "病毒", to: "BD" },
  { from: "肿瘤", to: "ZL瘤" }, { from: "癌症", to: "A症" }, { from: "养生", to: "Y生" },
];

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const raw = await readFile(FILTERS_PATH, "utf-8");
    return NextResponse.json({ ok: true, rules: JSON.parse(raw) });
  } catch {
    return NextResponse.json({ ok: true, rules: DEFAULT_FILTERS });
  }
}

export async function PATCH(req: NextRequest) {
  const { rules } = await req.json().catch(() => ({ rules: [] }));
  if (!Array.isArray(rules)) return NextResponse.json({ ok: false, error: "rules must be array" }, { status: 400 });
  await mkdir(dirname(FILTERS_PATH), { recursive: true });
  await writeFile(FILTERS_PATH, JSON.stringify(rules, null, 2), "utf-8");
  return NextResponse.json({ ok: true });
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** 字幕违规词替换规则 */
export type FilterRule = { from: string; to: string };

/** 从 data/subtitle-filters.json 读用户词库,失败/格式异常返回空数组(不影响主流程) */
export async function loadSubtitleFilters(): Promise<FilterRule[]> {
  try {
    const p = resolve(process.env.DATA_ROOT ?? "./data", "subtitle-filters.json");
    const raw = JSON.parse(await readFile(p, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is FilterRule => r && typeof r.from === "string" && r.from.length > 0 && typeof r.to === "string"
    );
  } catch {
    return [];
  }
}

/**
 * 按词库替换文本(长词优先,防短词覆盖长词)。
 * 幂等:规则的替换结果(to)不含任何规则的 from 时,重复应用不会二次改动——
 * 这也是"字幕对齐已替换过、渲染再应用一次"安全的前提。
 */
export function applySubtitleFilters(text: string, rules: FilterRule[]): string {
  if (!rules.length || !text) return text;
  let out = text;
  const sorted = [...rules].sort((a, b) => b.from.length - a.from.length);
  for (const r of sorted) {
    if (out.includes(r.from)) out = out.split(r.from).join(r.to);
  }
  return out;
}

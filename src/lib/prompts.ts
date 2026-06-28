/**
 * 提示词加载 —— 唯一运行时数据源是数据库 prompts_config 表。
 *
 * loadPrompt(step, track):
 *   1. 查库 step+track → 命中即用
 *   2. 查库 step+base  → 回退
 *   3. PROMPT_DEFAULTS 出厂默认(空库兜底,也是播种/恢复默认的来源)
 *
 * build 不存函数,存 buildTemplate(带 {占位符})。运行时用 interpolate 把
 * {transcript}/{viral}/{script}/{visual} 替换为实际输入(对象类型自动 JSON 化)。
 */

import { PROMPT_DEFAULTS } from "@/lib/prompt-defaults";

export interface PromptTemplate {
  system: string;
  build: (input: Record<string, unknown>) => string;
}

/** 占位符插值:{key} → input[key](字符串原样,对象/数组 JSON 化) */
export function interpolate(tpl: string, input: Record<string, unknown>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, key) => {
    const v = input[key];
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return JSON.stringify(v, null, 2);
  });
}

/** 把 {system, buildTemplate} 包成 PromptTemplate */
function toTemplate(system: string, buildTemplate: string): PromptTemplate {
  return {
    system,
    build: (input) => interpolate(buildTemplate, input),
  };
}

export async function loadPrompt(
  step: string,
  track: string
): Promise<PromptTemplate> {
  // 1+2. 查库:优先 step+track,回退 step+base
  try {
    const { db } = await import("@/db/client");
    const { promptsConfig } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(promptsConfig)
      .where(eq(promptsConfig.step, step));
    const exact = rows.find((r) => r.track === track);
    const base = rows.find((r) => r.track === "base");
    const hit = exact ?? base;
    if (hit) return toTemplate(hit.system, hit.buildTemplate);
  } catch {
    // 库不可用,落到出厂默认
  }

  // 3. 出厂默认兜底
  const def =
    PROMPT_DEFAULTS.find((d) => d.step === step && d.track === track) ??
    PROMPT_DEFAULTS.find((d) => d.step === step && d.track === "base");
  if (!def) {
    throw new Error(`no prompt for step "${step}" (track="${track}")`);
  }
  return toTemplate(def.system, def.buildTemplate);
}

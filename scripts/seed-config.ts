import "@/lib/loadenv";
import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { promptsConfig, apiConfigs } from "@/db/schema";
import { PROMPT_DEFAULTS } from "@/lib/prompt-defaults";
import { API_CONFIG_DEFS } from "@/lib/api-config-defs";

/**
 * 种子:把出厂提示词 + 当前 env 的 API 配置灌入库。
 * 幂等:已存在的行(按 step+track / key)跳过,不覆盖用户编辑。
 * 用法: npx tsx scripts/seed-config.ts
 */
async function main() {
  // 1. 提示词
  const existedPrompts = await db.select().from(promptsConfig);
  const promptKey = (s: string, t: string) => `${s}/${t}`;
  const havePrompt = new Set(existedPrompts.map((r) => promptKey(r.step, r.track)));
  let pAdded = 0;
  for (const d of PROMPT_DEFAULTS) {
    if (havePrompt.has(promptKey(d.step, d.track))) continue;
    await db.insert(promptsConfig).values({
      id: randomUUID(),
      step: d.step,
      track: d.track,
      system: d.system,
      buildTemplate: d.buildTemplate,
    });
    pAdded++;
  }

  // 2. API 配置(value 从当前 process.env 读,沿用现有)
  const existedApi = await db.select().from(apiConfigs);
  const haveApi = new Set(existedApi.map((r) => r.key));
  let aAdded = 0;
  for (const d of API_CONFIG_DEFS) {
    if (haveApi.has(d.key)) continue;
    await db.insert(apiConfigs).values({
      id: randomUUID(),
      provider: d.provider,
      key: d.key,
      value: process.env[d.key] ?? "",
      description: d.description,
      isSecret: d.isSecret ? 1 : 0,
    });
    aAdded++;
  }

  console.log(`种子完成:提示词 +${pAdded}/${PROMPT_DEFAULTS.length}, API配置 +${aAdded}/${API_CONFIG_DEFS.length}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

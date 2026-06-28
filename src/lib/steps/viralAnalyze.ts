import type { StepDef } from "./types";
import { chat, extractJson } from "@/lib/providers/llm";
import { loadPrompt } from "@/lib/prompts";
import { viralSchema, transcriptSchema, type Viral } from "@/lib/domain";

/**
 * viralAnalyze: 逐字稿 → 爆款结构 (hook/emotion/target/cta)。
 */
export const viralAnalyze: StepDef = {
  name: "viralAnalyze",
  deps: ["transcribe"],
  output: "viral.json",
  run: async (ctx) => {
    const transcript = transcriptSchema.parse(await ctx.readJSON("transcript.json"));
    const prompt = await loadPrompt("viralAnalyze", ctx.track);

    let viral: Viral;
    if (ctx.mode === "mock") {
      viral = {
        hook: "连续36小时不吃饭会怎样",
        emotion: "健康焦虑",
        target: "50+中老年女性",
        cta: "书里有完整答案",
        keywords: ["断食", "细胞修复", "养生"],
      };
    } else {
      const { content, cost } = await chat(
        prompt.system,
        prompt.build({ transcript: transcript.text }),
        ctx.mode,
        { json: true }
      );
      ctx.reportCost(cost, { provider: "llm", step: "viralAnalyze" });
      viral = viralSchema.parse(JSON.parse(extractJson(content)));
    }

    await ctx.writeJSON("viral.json", viral);
    ctx.log(`爆点: ${viral.hook} | 受众: ${viral.target}`);
    return { ok: true };
  },
};

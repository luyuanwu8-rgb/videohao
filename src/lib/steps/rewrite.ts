import type { StepDef } from "./types";
import { chat, extractJson } from "@/lib/providers/llm";
import { loadPrompt } from "@/lib/prompts";
import {
  rewriteSchema,
  viralSchema,
  transcriptSchema,
  type Rewrite,
} from "@/lib/domain";

/**
 * rewrite: 逐字稿 + 爆款结构 → 结构化改写稿 (title/sourceBook/hooks/script)。
 * 按赛道加载不同 prompt（health/emotion/...）。
 */
export const rewrite: StepDef = {
  name: "rewrite",
  deps: ["viralAnalyze"],
  output: "rewrite.json",
  run: async (ctx) => {
    const transcript = transcriptSchema.parse(await ctx.readJSON("transcript.json"));
    const viral = viralSchema.parse(await ctx.readJSON("viral.json"));
    const prompt = await loadPrompt("rewrite", ctx.track);

    let result: Rewrite;
    if (ctx.mode === "mock") {
      result = {
        title: "医生提醒：过了50岁，这样吃比吃药还管用",
        sourceBook: "《长寿饮食法》",
        hooks: ["连续36小时不吃饭会怎样", "身体的自我修复机制"],
        script:
          "你知道吗，连续36小时不吃饭，身体会发生惊人的变化。" +
          "细胞会启动自我修复机制，把堆积的垃圾清理掉。" +
          "这本书里讲透了背后的科学道理，跟着做，身体越来越轻松。",
      };
    } else {
      // JSON 解析重试(阶段5:LLM 偶发非法 JSON)
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        const { content, cost } = await chat(
          prompt.system,
          prompt.build({ transcript: transcript.text, viral }),
          ctx.mode,
          { json: true }
        );
        ctx.reportCost(cost, { provider: "llm", step: "rewrite" });
        try {
          result = rewriteSchema.parse(JSON.parse(extractJson(content)));
          break;
        } catch (e) {
          lastErr = e;
          ctx.log(`改写 JSON 解析失败(第${attempt + 1}次)，重试中…`);
        }
      }
      if (!result!) return { ok: false, error: `改写 JSON 解析失败: ${lastErr}` };
    }

    await ctx.writeJSON("rewrite.json", result, {
      meta: { title: result.title, sourceBook: result.sourceBook },
    });
    ctx.log(`改写完成: ${result.title} (${result.script.length}字)`);
    return { ok: true };
  },
};

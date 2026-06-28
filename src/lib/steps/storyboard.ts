import type { StepDef } from "./types";
import { chat, extractJson } from "@/lib/providers/llm";
import { loadPrompt } from "@/lib/prompts";
import { storyboardSchema, rewriteSchema, type Storyboard } from "@/lib/domain";
import { estimateDuration } from "@/lib/providers/stepfun";

/**
 * storyboard: 改写稿 → 分镜。每个 scene 同时是 TTS 和 Image 的生成单元。
 */
export const storyboard: StepDef = {
  name: "storyboard",
  deps: ["rewrite"],
  output: "storyboard.json",
  run: async (ctx) => {
    const rw = rewriteSchema.parse(await ctx.readJSON("rewrite.json"));
    const prompt = await loadPrompt("storyboard", ctx.track);

    let board: Storyboard;
    if (ctx.mode === "mock") {
      // 按句号切，造分镜
      const sentences = rw.script
        .split(/(?<=[。！？])/)
        .map((s) => s.trim())
        .filter(Boolean);
      board = {
        scenes: sentences.map((text, i) => ({
          id: i + 1,
          text,
          visual:
            i === 0
              ? "中老年女性惊讶的表情，温暖厨房背景"
              : "细胞修复概念图，柔和光线，科普感",
          estDuration: estimateDuration(text),
        })),
      };
    } else {
      // 最多重试 2 次（LLM 偶发返回非法 JSON）
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        const { content, cost } = await chat(
          prompt.system,
          prompt.build({ script: rw.script }),
          ctx.mode,
          { json: true }
        );
        ctx.reportCost(cost, { provider: "llm", step: "storyboard" });
        try {
          board = storyboardSchema.parse(JSON.parse(extractJson(content)));
          break; // 成功就退出重试
        } catch (e) {
          lastErr = e;
          ctx.log(`分镜 JSON 解析失败(第${attempt + 1}次)，重试中…`);
        }
      }
      if (!board!) return { ok: false, error: `分镜 JSON 解析失败: ${lastErr}` };
    }

    await ctx.writeJSON("storyboard.json", board);
    ctx.log(`分镜: ${board.scenes.length} 个 scene`);
    return { ok: true };
  },
};

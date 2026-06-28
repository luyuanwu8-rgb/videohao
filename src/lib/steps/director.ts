import type { StepDef } from "./types";
import { chat, extractJson } from "@/lib/providers/llm";
import { loadPrompt } from "@/lib/prompts";
import { storyboardSchema, rewriteSchema, directorSchema, type Director } from "@/lib/domain";

/**
 * director: 顶级导演层。读改写稿(剧本) + 分镜(已切好的句级 scene)，
 * 通读全文 → 定母题/情绪曲线/视觉基调/选角 → 把句子归并成"画面节拍"(beat)。
 *
 * 每个 beat = 覆盖哪几个 sceneId(决定该图显示多久) + 一张图的完整导演设计
 * (景别/情绪/构图/角色)。下游 imageGenerate 按 beat 出图(图数 = beat 数,远少于句数)，
 * timelineBuild 让每张图按其覆盖句子的配音总时长显示。
 *
 * 产物 director.json。前端「导演分镜」面板可改 audience/视觉基调/选角/逐拍设计。
 */
export const director: StepDef = {
  name: "director",
  deps: ["assetSearch"],
  output: "director.json",
  run: async (ctx) => {
    const board = storyboardSchema.parse(await ctx.readJSON("storyboard.json"));
    const rw = rewriteSchema.parse(await ctx.readJSON("rewrite.json"));
    const sceneIds = board.scenes.map((s) => s.id);

    let plan: Director;
    if (ctx.mode === "mock") {
      // mock：每 3 句归一拍，造占位导演方案
      const beats = [];
      for (let i = 0; i < board.scenes.length; i += 3) {
        const group = board.scenes.slice(i, i + 3);
        beats.push({
          id: beats.length + 1,
          sceneIds: group.map((s) => s.id),
          use: "cast:A",
          shotType: "中景",
          mood: "平和",
          composition: group[0].visual || "温暖生活场景",
        });
      }
      plan = {
        audience: "中老年(50-70岁)",
        theme: "顺应身体的智慧",
        emotionArc: "焦虑 → 好奇 → 释然",
        visualTone: "写实纪实质感,温暖自然光,成熟审美,绝非卡通",
        cast: [{ id: "A", bible: "65岁中国老年女性,银发,慈祥圆脸,深色对襟开衫" }],
        beats,
      };
    } else {
      const prompt = await loadPrompt("director", ctx.track);
      // 把分镜句子编号喂给导演，让它按 sceneId 归并节拍
      const sceneList = board.scenes.map((s) => `[${s.id}] ${s.text}`).join("\n");
      let parsed: Director | null = null;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        const { content, cost } = await chat(
          prompt.system,
          prompt.build({ script: rw.script, sourceBook: rw.sourceBook, sceneList }),
          ctx.mode,
          { json: true }
        );
        ctx.reportCost(cost, { provider: "llm", step: "director" });
        try {
          parsed = directorSchema.parse(JSON.parse(extractJson(content)));
          break;
        } catch (e) {
          lastErr = e;
          ctx.log(`导演方案 JSON 解析失败(第${attempt + 1}次)，重试中…`);
        }
      }
      if (!parsed) return { ok: false, error: `导演方案解析失败: ${lastErr}` };
      plan = parsed;
    }

    // 兜底校验：确保每个 sceneId 都被某拍覆盖（导演可能漏分），漏的并入最后一拍
    const covered = new Set(plan.beats.flatMap((b) => b.sceneIds));
    const missing = sceneIds.filter((id) => !covered.has(id));
    if (missing.length && plan.beats.length) {
      plan.beats[plan.beats.length - 1].sceneIds.push(...missing);
      ctx.log(`补漏：${missing.length} 个句子并入末拍`);
    }

    await ctx.writeJSON("director.json", plan);
    ctx.log(`导演方案: ${plan.beats.length} 个画面节拍 / ${sceneIds.length} 句 · 角色 ${plan.cast.length} 个`);
    return { ok: true };
  },
};

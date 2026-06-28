import type { StepDef } from "./types";
import { storyboardSchema } from "@/lib/domain";

/**
 * ☆ assetSearch: 素材复用库检索。v1 留接缝、不实现。
 *
 * 现在是直通节点：把 storyboard 原样透传给 imageGenerate，
 * 并标记每个 scene "未命中复用"。
 *
 * 将来实现时：对每个 scene.visual 做文本 embedding → 向量搜索 assets 表 →
 * 命中相似图则复用（reused=true），未命中才交给 imageGenerate。
 */
export const assetSearch: StepDef = {
  name: "assetSearch",
  deps: ["storyboard"],
  output: "asset-hits.json",
  run: async (ctx) => {
    const board = storyboardSchema.parse(await ctx.readJSON("storyboard.json"));
    // v1：全部未命中，等价于直通
    const hits = board.scenes.map((s) => ({ sceneId: s.id, hit: false, assetPath: null }));
    await ctx.writeJSON("asset-hits.json", { hits });
    ctx.log(`素材复用: 0/${board.scenes.length} 命中（v1 接缝，未启用）`);
    return { ok: true };
  },
};

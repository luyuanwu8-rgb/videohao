import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { StepDef } from "./types";
import { fetchVideo, downloadVideo, parseShareInput } from "@/lib/providers/tikhub";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * extract: 抖音分享链接 → 视频 + 元数据。
 * 元数据写入 tasks.sourceMeta（替代手动贴 Excel）。
 */
export const extract: StepDef = {
  name: "extract",
  deps: [],
  output: "source.json",
  run: async (ctx) => {
    const input = ctx.task.sourceUrl ?? "";
    if (!input.trim()) return { ok: false, error: "task 没有 sourceUrl" };
    ctx.log(`解析链接: ${parseShareInput(input)}`);

    const meta = await fetchVideo(input, ctx.mode);
    ctx.reportCost(ctx.mode === "real" ? 0.001 : 0, { provider: "tikhub" });

    await ctx.writeJSON("source.json", meta, {
      meta: { author: meta.author, plays: meta.stats.plays },
    });

    // 元数据快照进 tasks 表，列表页直接可见
    await db
      .update(tasks)
      .set({ title: meta.title, sourceMeta: meta as unknown as Record<string, unknown> })
      .where(eq(tasks.id, ctx.task.id));

    if (ctx.mode === "real") {
      await mkdir(ctx.taskDir, { recursive: true });
      await downloadVideo(meta.videoUrl, join(ctx.taskDir, "source.mp4"), ctx.mode);
    }
    ctx.log(`元数据已保存: ${meta.title}`);
    return { ok: true };
  },
};

import type { StepDef } from "./types";
import { timelineSchema } from "@/lib/timeline";
import { renderTimeline } from "@/hyperframes/render";
import { validateRenderedVideo } from "@/hyperframes/validate";
import { DEFAULT_MOTION, MOTION_KEYS, motionPreset } from "@/lib/motions";
import { z } from "zod";

const renderConfigSchema = z.object({
  motions: z.array(z.string()).optional(),
  motion: z.enum(["kenBurns", "zoomIn", "static"]).optional(),
});

const LEGACY_MOTION: Record<string, string> = {
  kenBurns: "cinematic",
  zoomIn: "fastcut",
  static: "zen",
};

/**
 * render: 读各动效的 timeline-<key>.json → 渲染后端 → renders/<key>.mp4。
 *
 * 多动效批量：有几个 timeline-*.json 就渲几条成片，各登记 artifact。
 * 第一条同时落 final.mp4（兼容单条链路 + output 完成度判断）。
 * 渲染后端通过 renderTimeline 抽象（默认 HyperFrames）。
 */
export const render: StepDef = {
  name: "render",
  deps: ["timelineBuild"],
  output: "final.mp4",
  run: async (ctx) => {
    // 找出本任务有哪些动效 timeline（timelineBuild 产出 timeline-<key>.json）
    const motions = await listMotionTimelines(ctx);

    if (motions.length === 0) {
      // 兜底：没有分动效文件，按老逻辑渲 timeline.json
      const timeline = timelineSchema.parse(await ctx.readJSON("timeline.json"));
      const r = await renderTimeline({
        timeline, taskDir: ctx.taskDir, outRel: "final.mp4", mode: ctx.mode, log: ctx.log,
      });
      if (!r.ok) return { ok: false, error: r.error };
      await ctx.registerArtifact("final.mp4", { fileType: "mp4" });
      ctx.log("成片: final.mp4");
      return { ok: true };
    }

    const produced: string[] = [];
    for (let i = 0; i < motions.length; i++) {
      const key = motions[i];
      const preset = motionPreset(key);
      const timeline = timelineSchema.parse(await ctx.readJSON(`timeline-${key}.json`));
      const outRel = `renders/${key}.mp4`;
      const r = await renderTimeline({
        timeline, taskDir: ctx.taskDir, outRel, mode: ctx.mode, log: ctx.log,
      });
      if (!r.ok) return { ok: false, error: `动效[${key}] 渲染失败: ${r.error}` };
      await ctx.registerArtifact(outRel, {
        fileType: "mp4",
        tag: `render:${key}`,
        meta: { motion: key, label: preset.label },
      });
      produced.push(key);

      // 第一条直接 copy 成 final.mp4（兼容现有单条链路/output判断，不重复渲染）
      if (i === 0) {
        const { copyFile, rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { existsSync } = await import("node:fs");
        const finalPath = join(ctx.taskDir, "final.mp4");
        const srcPath = join(ctx.taskDir, outRel);
        try {
          if (existsSync(finalPath)) await rm(finalPath, { force: true });
        } catch { /* 占用则跳过删，copy 覆盖 */ }
        try {
          await copyFile(srcPath, finalPath);
        } catch (e) {
          return { ok: false, error: `复制 ${outRel} 到 final.mp4 失败: ${e instanceof Error ? e.message : e}` };
        }
        if (ctx.mode !== "mock") {
          const finalCheck = await validateRenderedVideo({ filePath: finalPath, timeline, log: ctx.log });
          if (!finalCheck.ok) return { ok: false, error: `final.mp4 验收失败: ${finalCheck.error}` };
        }
        await ctx.registerArtifact("final.mp4", { fileType: "mp4" });
      }
      ctx.log(`成片 ${i + 1}/${motions.length}: ${outRel} (${preset.label})`);
    }

    ctx.log(`全部成片完成: ${produced.length} 条 [${produced.join(",")}]`);
    return { ok: true };
  },
};

/** 列出任务目录里的 timeline-<key>.json 对应的动效 key（按 motions.ts 顺序） */
async function listMotionTimelines(ctx: {
  taskDir: string;
  readJSON: <T>(relPath: string) => Promise<T>;
}): Promise<string[]> {
  let desired: string[] = [];
  try {
    const cfg = renderConfigSchema.parse(await ctx.readJSON("render-config.json"));
    desired = (cfg.motions ?? []).filter((m) => MOTION_KEYS.includes(m));
    if (desired.length === 0 && cfg.motion) {
      const mapped = LEGACY_MOTION[cfg.motion];
      if (mapped) desired = [mapped];
    }
  } catch {
    desired = [];
  }
  if (desired.length === 0) desired = [DEFAULT_MOTION];

  const { access, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const existing: string[] = [];
  for (const key of desired) {
    const ok = await access(join(ctx.taskDir, `timeline-${key}.json`))
      .then(() => true)
      .catch(() => false);
    if (ok) existing.push(key);
  }
  if (existing.length > 0) return existing;

  const files = await readdir(ctx.taskDir).catch(() => [] as string[]);
  const present = new Set(
    files
      .map((f) => f.match(/^timeline-(.+)\.json$/)?.[1])
      .filter((x): x is string => !!x)
  );
  // 按预设顺序返回，保证 final.mp4 = 第一个预设
  return MOTION_KEYS.filter((k) => present.has(k));
}

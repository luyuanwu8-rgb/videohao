import type { StepDef } from "./types";
import {
  storyboardSchema,
  voiceSchema,
  imagesSchema,
  rewriteSchema,
} from "@/lib/domain";
import { timelineSchema, type Timeline } from "@/lib/timeline";
import { motionPreset, DEFAULT_MOTION, MOTION_KEYS } from "@/lib/motions";
import { z } from "zod";

const subtitleFileSchema = z.object({
  cues: z.array(
    z.object({ start: z.number(), end: z.number(), text: z.string() })
  ),
});

// 风格运镜配置（来自工作台「风格运镜」检查点）。
// motions：要批量产出的动效列表（多选）；兼容旧的单 motion 字段。
const renderConfigSchema = z.object({
  motions: z.array(z.string()).optional(),
  motion: z.enum(["kenBurns", "zoomIn", "static"]).optional(), // 旧字段，兼容
  disclaimer: z.string().default(""),
});

// 旧 motion 名 → 新动效预设名映射（兼容历史配置）
const LEGACY_MOTION: Record<string, string> = {
  kenBurns: "cinematic",
  zoomIn: "fastcut",
  static: "zen",
};

/**
 * timelineBuild: 汇合视觉线(图)+音频线(配音/字幕)，用真实配音时长合成 timeline。
 *
 * 多动效批量：render-config.json 的 motions[] 指定要出哪几条动效，
 * 每个动效产一份 timeline-<key>.json；同时把第一个写成 timeline.json（兼容单条链路）。
 */
export const timelineBuild: StepDef = {
  name: "timelineBuild",
  deps: ["imageGenerate", "subtitleAlign"],
  output: "timeline.json",
  run: async (ctx) => {
    const board = storyboardSchema.parse(await ctx.readJSON("storyboard.json"));
    const voice = voiceSchema.parse(await ctx.readJSON("voice.json"));
    const images = imagesSchema.parse(await ctx.readJSON("images.json"));
    const subtitle = subtitleFileSchema.parse(await ctx.readJSON("subtitle.json"));

    let cfg = renderConfigSchema.parse({});
    try {
      cfg = renderConfigSchema.parse(await ctx.readJSON("render-config.json"));
    } catch {
      /* 无配置走默认 */
    }

    // 声明文字占位符替换 {author}/{title}（取自 rewrite.json）
    let disclaimer = cfg.disclaimer.trim();
    if (disclaimer.includes("{author}") || disclaimer.includes("{title}")) {
      try {
        const rw = rewriteSchema.parse(await ctx.readJSON("rewrite.json"));
        disclaimer = disclaimer
          .replace(/\{author\}/g, rw.sourceBook ? "" : "") // 作者暂无独立字段，留空
          .replace(/\{title\}/g, rw.sourceBook ?? "");
      } catch {
        /* 无 rewrite 则原样保留 */
      }
    }

    // 解析要产出的动效列表：优先 motions[]，回退旧 motion，再回退默认
    let motions = (cfg.motions ?? []).filter((m) => MOTION_KEYS.includes(m));
    if (motions.length === 0 && cfg.motion) {
      const mapped = LEGACY_MOTION[cfg.motion];
      if (mapped) motions = [mapped];
    }
    if (motions.length === 0) motions = [DEFAULT_MOTION];

    const W = 1080;
    const H = 1920;
    const FPS = 24; // 图书带货(图+字幕+缓慢运镜)24fps 肉眼无差，比 30 少 20% 帧，明显提速
    const durBySc = new Map(voice.segments.map((s) => [s.sceneId, s.duration]));
    // 路线C(阶段4):一个 scene 可被多拍共享(长句配多图)。统计每句被几张图覆盖,
    // 按图数均分该句时长,图按节拍顺序连续铺满 → 长台词也有画面变化,音画仍精确对齐。
    const coverCount = new Map<number, number>();
    for (const img of images.items) for (const id of img.sceneIds ?? []) coverCount.set(id, (coverCount.get(id) ?? 0) + 1);

    // 为单个动效构建一份 timeline
    const buildOne = (motionKey: string): Timeline => {
      const preset = motionPreset(motionKey);
      const tracks: Timeline["tracks"] = [];

      // 1) 音频线：逐句配音（句级，连续铺满），同时记录每个 scene 的起始时刻
      const sceneStart = new Map<number, number>();
      let cursor = 0;
      for (const scene of board.scenes) {
        const dur = durBySc.get(scene.id) ?? scene.estDuration;
        sceneStart.set(scene.id, cursor);
        const seg = voice.segments.find((s) => s.sceneId === scene.id);
        if (seg) {
          tracks.push({
            type: "audio",
            src: seg.audioPath,
            start: cursor,
            duration: dur,
            volume: 1,
            role: "voice",
          });
        }
        cursor += dur;
      }
      const totalDur = cursor;

      // 2) 画面线:图按节拍顺序连续铺满;每张图时长 = Σ(覆盖句时长 / 该句被几张图共享)
      let imgCursor = 0;
      for (const img of images.items) {
        const ids = img.sceneIds?.length ? img.sceneIds : [];
        if (!ids.length) continue;
        const imgDur =
          ids.reduce((sum, id) => sum + (durBySc.get(id) ?? 0) / (coverCount.get(id) ?? 1), 0) || 0.1;
        tracks.push({
          type: "image",
          src: img.imagePath,
          start: imgCursor,
          duration: imgDur,
          zoom: preset.zoom,
          sceneId: ids[0],
        });
        imgCursor += imgDur;
      }

      tracks.push({
        type: "subtitle",
        cues: subtitle.cues,
        style: { fontFamily: "Microsoft YaHei", fontSize: 18, color: "#FFDE00", marginV: 220 },
      });

      if (disclaimer) {
        tracks.push({
          type: "text",
          text: disclaimer,
          start: 0,
          duration: Math.max(0.1, totalDur),
          role: "disclaimer",
        });
      }

      return timelineSchema.parse({
        version: 1,
        width: W,
        height: H,
        fps: FPS,
        duration: totalDur,
        tracks,
        motion: motionKey,
      });
    };

    // 逐动效产出 timeline-<key>.json
    for (const m of motions) {
      await ctx.writeJSON(`timeline-${m}.json`, buildOne(m));
    }
    // 兼容：第一个动效同时写 timeline.json（render 单条链路 + output 完成度判断）
    const primary = buildOne(motions[0]);
    await ctx.writeJSON("timeline.json", primary);

    ctx.log(
      `timeline: ${primary.tracks.length} 轨/条, ${motions.length} 个动效 [${motions.join(",")}]`
    );
    return { ok: true };
  },
};

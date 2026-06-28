import { z } from "zod";

/**
 * timeline.json — 最终渲染契约。
 *
 * 这是上层流水线与渲染后端之间唯一的接口。
 * 只要 timelineBuild 产出符合本 schema 的 timeline.json，
 * 渲染后端换 HyperFrames / Remotion / FFmpeg 都不影响上层逻辑。
 *
 * 时间单位：秒（浮点）。坐标/尺寸单位：像素（基于 composition 的 width/height）。
 */

// 单个 track item 的几种类型
export const imageClipSchema = z.object({
  type: z.literal("image"),
  src: z.string(), // 相对 data/tasks/{id}/ 的路径，如 images/1.png
  start: z.number().nonnegative(),
  duration: z.number().positive(),
  // 缩放动画（Ken Burns），from→to 的统一缩放比
  zoom: z
    .object({ from: z.number(), to: z.number() })
    .optional(),
  sceneId: z.number().int().optional(), // 回链到 storyboard 的 scene
});

export const videoClipSchema = z.object({
  type: z.literal("video"),
  src: z.string(),
  start: z.number().nonnegative(),
  duration: z.number().positive(),
  muted: z.boolean().default(true),
});

export const audioClipSchema = z.object({
  type: z.literal("audio"),
  src: z.string(),
  start: z.number().nonnegative(),
  duration: z.number().positive(),
  volume: z.number().min(0).default(1),
  role: z.enum(["voice", "bgm"]).default("voice"),
});

export const subtitleCueSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().positive(),
  text: z.string(),
});

export const subtitleTrackSchema = z.object({
  type: z.literal("subtitle"),
  cues: z.array(subtitleCueSchema),
  // 样式留给渲染层，协议只描述"烧录哪些字、什么时间"
  style: z
    .object({
      fontFamily: z.string().optional(),
      fontSize: z.number().optional(),
      color: z.string().optional(),
      marginV: z.number().optional(),
    })
    .optional(),
});

export const textOverlaySchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  start: z.number().nonnegative(),
  duration: z.number().positive(),
  role: z.enum(["title", "subtitle", "disclaimer"]).default("title"),
});

export const trackItemSchema = z.discriminatedUnion("type", [
  imageClipSchema,
  videoClipSchema,
  audioClipSchema,
  subtitleTrackSchema,
  textOverlaySchema,
]);

export const timelineSchema = z.object({
  version: z.literal(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
  duration: z.number().positive(), // 总时长（秒），= 各 scene 真实配音时长之和
  tracks: z.array(trackItemSchema),
  // 动效预设名（cinematic/fastcut/zen/film）。渲染层据此应用入场淡入/滤镜/缓动。
  motion: z.string().optional(),
});

export type Timeline = z.infer<typeof timelineSchema>;
export type ImageClip = z.infer<typeof imageClipSchema>;
export type AudioClip = z.infer<typeof audioClipSchema>;
export type SubtitleCue = z.infer<typeof subtitleCueSchema>;

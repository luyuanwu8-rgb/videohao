import { z } from "zod";

/**
 * 各 step 产物的领域类型（zod schema + 推导 TS 类型）。
 * 这些是流水线内部 step 之间传递的结构化数据，落盘为 data/tasks/{id}/*.json。
 */

// transcribe: 逐字稿 + 词级时间戳
export const wordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
});
export const transcriptSchema = z.object({
  text: z.string(),
  words: z.array(wordSchema).default([]),
  language: z.string().default("zh"),
});
export type Transcript = z.infer<typeof transcriptSchema>;

// viralAnalyze: 爆款结构分析（保留爆点，指导改写）
export const viralSchema = z.object({
  hook: z.string(), // 开头钩子
  emotion: z.string(), // 情绪：健康焦虑 / 怀旧 / ...
  target: z.string(), // 受众：50+女性 / ...
  cta: z.string(), // 转化点：书里有完整答案
  keywords: z.array(z.string()).default([]),
});
export type Viral = z.infer<typeof viralSchema>;

// rewrite: 结构化改写稿（不只是改写文本，含拆解）
export const rewriteSchema = z.object({
  title: z.string(), // 视频标题
  sourceBook: z.string().default(""), // 反推的书名
  hooks: z.array(z.string()).default([]),
  script: z.string(), // 完整口播稿
});
export type Rewrite = z.infer<typeof rewriteSchema>;

// storyboard: 分镜。每个 scene 同时是 TTS 和 Image 的生成单元。
export const sceneSchema = z.object({
  id: z.number().int(),
  text: z.string(), // 该镜头的口播文字（喂 TTS）
  visual: z.string(), // 画面描述（喂 image step 转 prompt）
  estDuration: z.number().positive().default(4), // LLM 估时，仅占位；真相来自 TTS
});
export const storyboardSchema = z.object({
  scenes: z.array(sceneSchema),
});
export type Scene = z.infer<typeof sceneSchema>;
export type Storyboard = z.infer<typeof storyboardSchema>;

// tts: 每个 scene 一段配音，记录真实时长
export const voiceSegmentSchema = z.object({
  sceneId: z.number().int(),
  audioPath: z.string(), // 相对路径，如 voice/1.wav
  duration: z.number().positive(), // 真实时长（秒），来自音频探测
});
export const voiceSchema = z.object({
  segments: z.array(voiceSegmentSchema),
  totalDuration: z.number().nonnegative(),
});
export type VoiceSegment = z.infer<typeof voiceSegmentSchema>;
export type Voice = z.infer<typeof voiceSchema>;

// voice-config: 配音的任务级配置（provider/音色/语速），由配音面板编辑，tts 步读取
export const voiceConfigSchema = z.object({
  provider: z.enum(["volcengine", "stepfun"]).default("volcengine"),
  voice: z.string().default("zh_male_jieshuoxiaoming_moon_bigtts"),
  speed: z.number().min(0.2).max(3).default(1.0),
});
export type VoiceConfig = z.infer<typeof voiceConfigSchema>;

// image: 每个画面节拍(beat)一张图。一张图覆盖若干 sceneId(决定显示时长)。
export const imageItemSchema = z.object({
  beatId: z.number().int().default(0), // 来自导演的画面节拍号
  sceneIds: z.array(z.number().int()).default([]), // 本图覆盖的句子(决定显示多久)
  imagePath: z.string(),
  prompt: z.string(),
  visual: z.string(), // 冗余存一份(导演 composition)，将来 embed 做复用匹配
  reused: z.boolean().default(false), // 是否来自素材库复用（v1 恒 false）
});
export const imagesSchema = z.object({
  items: z.array(imageItemSchema),
});
export type ImageItem = z.infer<typeof imageItemSchema>;
export type Images = z.infer<typeof imagesSchema>;

// director: 导演规划。把句级分镜归并成"画面节拍"，每拍一张图，含镜头语言+选角。
// 角色卡：反复出现的叙事人物，保证同叙事线人物一致。
export const castSchema = z.object({
  id: z.string(), // 引用键，如 "A"
  bible: z.string(), // 角色设定，如 "65岁中国老年女性,银发,慈祥圆脸,深色开衫"
});
// 画面节拍：覆盖哪几个 scene（→显示时长由这些 scene 配音时长合计）+ 一张图的完整导演设计
export const beatSchema = z.object({
  id: z.number().int(), // 节拍序号(从1)
  sceneIds: z.array(z.number().int()), // 本拍覆盖的 scene id（连续，决定该图显示多久）
  use: z.string().default("空镜"), // "cast:A" / "空镜" / "配角"
  shotType: z.string().default(""), // 景别：面部特写/全景/中景…
  mood: z.string().default(""), // 本拍情绪（服务情绪曲线）
  composition: z.string(), // 构图+光线+场景（喂 image step 的核心）
});
export const directorSchema = z.object({
  audience: z.string().default(""), // 目标受众（前端可改，导演据此选角）
  theme: z.string().default(""), // 全片母题
  emotionArc: z.string().default(""), // 情绪曲线
  visualTone: z.string().default(""), // 全局视觉基调（写实度/色调/审美）
  cast: z.array(castSchema).default([]), // 反复出现的角色卡
  beats: z.array(beatSchema), // 画面节拍序列
});
export type Cast = z.infer<typeof castSchema>;
export type Beat = z.infer<typeof beatSchema>;
export type Director = z.infer<typeof directorSchema>;

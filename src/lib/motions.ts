/**
 * 动效预设 — 「成片风格与数量」里的 motion preset。
 *
 * 一个任务可多选若干动效，每个动效产出一条独立成片（风格×动效批量的动效维度）。
 * 每个预设描述：图片缩放(zoom)、入场淡入时长(fadeIn)、画面滤镜(filter)、缓动(ease)。
 * timelineBuild 把 zoom 烤进 image clip，template 按 motion 名应用 fadeIn/filter/ease。
 *
 * 渲染层(template)与构建层(timelineBuild)共用本表，保证一致。
 */

export interface MotionPreset {
  key: string;
  label: string;
  desc: string;
  zoom: { from: number; to: number }; // 图片缩放，static 用 1→1
  fadeIn: number; // 入场淡入秒数（0=硬切）
  ease: string; // GSAP 缓动
  filter: string; // CSS filter，"" = 无
}

export const MOTION_PRESETS: MotionPreset[] = [
  {
    key: "cinematic",
    label: "电影感",
    desc: "交叉溶解 + Ken Burns 慢推",
    zoom: { from: 1.0, to: 1.08 },
    fadeIn: 0.6,
    ease: "none",
    filter: "",
  },
  {
    key: "fastcut",
    label: "动感快剪",
    desc: "快速缩放 + 短切换",
    zoom: { from: 1.06, to: 1.16 },
    fadeIn: 0.15,
    ease: "power1.out",
    filter: "saturate(1.15) contrast(1.05)",
  },
  {
    key: "zen",
    label: "禅意静帧",
    desc: "极缓中放大 + 长淡入淡出",
    zoom: { from: 1.0, to: 1.035 },
    fadeIn: 1.0,
    ease: "sine.inOut",
    filter: "brightness(1.02)",
  },
  {
    key: "film",
    label: "胶片复古",
    desc: "复古色调 + 缓推",
    zoom: { from: 1.0, to: 1.06 },
    fadeIn: 0.5,
    ease: "none",
    filter: "sepia(0.28) contrast(1.08) saturate(0.92)",
  },
];

export const MOTION_KEYS = MOTION_PRESETS.map((m) => m.key);
export const DEFAULT_MOTION = "cinematic";

export function motionPreset(key: string): MotionPreset {
  return MOTION_PRESETS.find((m) => m.key === key) ?? MOTION_PRESETS[0];
}

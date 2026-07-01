import type { Timeline } from "@/lib/timeline";
import { motionPreset, DEFAULT_MOTION } from "@/lib/motions";

/**
 * timeline.json → HyperFrames composition HTML。
 *
 * 把渲染协议翻译成 HyperFrames 的 DOM + GSAP 时间线：
 *   - image clip  → <img class="clip" data-start/duration/track> + GSAP scale 缩放
 *   - audio clip  → <audio data-start/duration/track>
 *   - subtitle    → 每个 cue 一个 <div class="clip subtitle">
 *   - text        → <div class="clip"> 标题/免责声明
 *
 * 关键约束（已由本地验证确认）：
 *   中文必须用打包字体 + @font-face，不能依赖系统字体，否则无头 Chrome 渲成方框。
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildCompositionHtml(timeline: Timeline): string {
  const { width, height, fps, duration, tracks } = timeline;
  const sub = tracks.find((t) => t.type === "subtitle");
  const subStyle = sub && sub.type === "subtitle" ? sub.style ?? {} : {};
  const fontSize = subStyle.fontSize ?? 18;
  const color = subStyle.color ?? "#FFDE00";
  const marginV = subStyle.marginV ?? 220;

  // 动效预设：决定图片缩放缓动、入场淡入、画面滤镜
  const preset = motionPreset(timeline.motion ?? DEFAULT_MOTION);
  const imgFilter = preset.filter; // 应用到所有 .scene-img 的 CSS filter

  const bodyParts: string[] = [];
  const tweens: string[] = [];
  let imgIdx = 0;

  for (const t of tracks) {
    if (t.type === "image") {
      const id = `img${++imgIdx}`;
      bodyParts.push(
        `<img id="${id}" class="clip scene-img" src="${esc(t.src)}" ` +
          `data-start="${t.start}" data-duration="${t.duration}" data-track-index="0" />`
      );
      if (t.zoom) {
        tweens.push(
          `tl.fromTo("#${id}",{scale:${t.zoom.from}},` +
            `{scale:${t.zoom.to},duration:${t.duration},ease:"${preset.ease}"},${t.start});`
        );
      }
      // 入场淡入（动效预设决定时长；0 则硬切不加）
      if (preset.fadeIn > 0) {
        const fd = Math.min(preset.fadeIn, t.duration / 2);
        tweens.push(
          `tl.fromTo("#${id}",{opacity:0},{opacity:1,duration:${fd.toFixed(2)},ease:"power1.out"},${t.start});`
        );
      }
    } else if (t.type === "audio") {
      const trackIdx = t.role === "bgm" ? 9 : 1;
      bodyParts.push(
        `<audio src="${esc(t.src)}" data-start="${t.start}" ` +
          `data-duration="${t.duration}" data-track-index="${trackIdx}"></audio>`
      );
    } else if (t.type === "subtitle") {
      for (const cue of t.cues) {
        const dur = Math.max(0.1, cue.end - cue.start);
        bodyParts.push(
          `<div class="clip subtitle" data-start="${cue.start}" ` +
            `data-duration="${dur}" data-track-index="2">${esc(cue.text)}</div>`
        );
      }
    } else if (t.type === "text") {
      bodyParts.push(
        `<div class="clip text-${t.role}" data-start="${t.start}" ` +
          `data-duration="${t.duration}" data-track-index="3">${esc(t.text)}</div>`
      );
    }
  }

  return `<!doctype html>
<html lang="zh-CN" data-resolution="portrait">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <script src="assets/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      @font-face {
        font-family: "HeiCN";
        src: url("assets/fonts/simhei.ttf") format("truetype");
        font-weight: 700;
      }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
      body { font-family: "HeiCN", sans-serif; }
      .scene-img { position: absolute; inset: 0; width: ${width}px; height: ${height}px; object-fit: cover;${imgFilter ? ` filter: ${imgFilter};` : ""} }
      .subtitle {
        position: absolute; left: 0; right: 0; bottom: ${marginV}px; text-align: center;
        font-size: ${fontSize * 3}px; font-weight: 700; color: ${color};
        font-family: "HeiCN", sans-serif;
        text-shadow: 0 0 8px #000, 0 0 8px #000, 0 4px 6px #000;
        padding: 0 60px; line-height: 1.4;
      }
      .text-title {
        position: absolute; left: 0; right: 0; top: 120px; text-align: center;
        font-size: ${fontSize * 4}px; font-weight: 700; color: ${color};
        font-family: "HeiCN", sans-serif; text-shadow: 0 0 10px #000; padding: 0 60px;
      }
      .text-disclaimer {
        position: absolute; left: 0; right: 0; bottom: 40px; text-align: center;
        font-size: ${fontSize * 1.4}px; font-weight: 400; color: rgba(255,255,255,0.7);
        font-family: "HeiCN", sans-serif; text-shadow: 0 0 6px #000; padding: 0 50px;
      }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration}"
         data-width="${width}" data-height="${height}">
${bodyParts.map((p) => "      " + p).join("\n")}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
${tweens.map((t) => "      " + t).join("\n")}
      // 关键：composition 总时长 = GSAP timeline 时长（与 data-duration 无关）。
      // 必须把 timeline 显式钉到整片总时长，否则最后一个 tween 之后的帧
      // （尤其靠后的长镜头）会被 seek 到 timeline 末尾之外，clip 生命周期失效 → 黑屏。
      // 见 HyperFrames 文档 Common Mistakes: Composition duration shorter than video。
      tl.set({}, {}, ${duration});
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

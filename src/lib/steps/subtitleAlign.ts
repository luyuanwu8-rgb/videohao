import type { StepDef } from "./types";
import { storyboardSchema, voiceSchema } from "@/lib/domain";
import type { SubtitleCue } from "@/lib/timeline";
import { loadSubtitleFilters, applySubtitleFilters } from "@/lib/subtitleFilters";

/**
 * subtitleAlign: 生成对齐字幕 cues。
 *
 * 不再调 ASR。因为配音是我们自己用 TTS 生成的——每个 scene 的文字和
 * 它的真实时长都已知。把每个 scene 的文字按标点/字数切成短句，
 * 按字数比例摊到该 scene 的真实时长上即可。
 *
 * 好处：零额外成本、不依赖任何 ASR 时间戳、对齐稳定可控。
 */

const MAX_CHARS_PER_CUE = 18;

export const subtitleAlign: StepDef = {
  name: "subtitleAlign",
  deps: ["tts"],
  output: "subtitle.json",
  run: async (ctx) => {
    const board = storyboardSchema.parse(await ctx.readJSON("storyboard.json"));
    const voice = voiceSchema.parse(await ctx.readJSON("voice.json"));
    const sceneText = new Map(board.scenes.map((s) => [s.id, s.text]));
    const filters = await loadSubtitleFilters(); // 用户词库，始终应用

    const cues: SubtitleCue[] = [];
    let cursor = 0;
    for (const seg of voice.segments) {
      const text = (sceneText.get(seg.sceneId) ?? "").trim();
      const chunks = splitToChunks(text);
      const totalChars = chunks.reduce((a, c) => a + c.length, 0) || 1;
      let local = cursor;
      chunks.forEach((chunk, i) => {
        const dur = i === chunks.length - 1
          ? cursor + seg.duration - local
          : (chunk.length / totalChars) * seg.duration;
        const display = filters.length ? applySubtitleFilters(chunk, filters) : chunk;
        cues.push({ start: local, end: local + dur, text: display });
        local += dur;
      });
      cursor += seg.duration;
    }

    await ctx.writeJSON("subtitle.json", { cues });
    ctx.log(`字幕: ${cues.length} 条, 跨度 ${cursor.toFixed(1)}s` + (filters.length ? `（已应用 ${filters.length} 条词库替换规则）` : ""));
    return { ok: true };
  },
};

/** 按中文标点优先切句，过长再按字数硬切 */
function splitToChunks(text: string): string[] {
  if (!text) return [];
  const parts = text
    .split(/(?<=[，。！？、；,.!?;])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (p.length <= MAX_CHARS_PER_CUE) {
      out.push(p);
    } else {
      for (let i = 0; i < p.length; i += MAX_CHARS_PER_CUE) {
        out.push(p.slice(i, i + MAX_CHARS_PER_CUE));
      }
    }
  }
  return out.length ? out : [text];
}

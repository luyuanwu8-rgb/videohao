import type { StepDef } from "./types";
import { chat, parseJsonRobust } from "@/lib/providers/llm";
import { loadPrompt } from "@/lib/prompts";
import { storyboardSchema, rewriteSchema, type Storyboard } from "@/lib/domain";
import { estimateDuration } from "@/lib/providers/stepfun";
import { normalizeCoverageText, validateScriptCoverage } from "@/lib/scriptCoverage";
import {
  buildBookShowcaseConfig,
  loadBookShowcaseConfig,
  saveBookShowcaseConfig,
} from "@/lib/bookCover";

const MIN_SCENES = 30;
const MAX_SCENES = 50;
const IDEAL_MAX_CHARS = 145;
const HARD_MAX_CHARS = 220;

function textLen(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function splitLongSentence(sentence: string): string[] {
  if (textLen(sentence) <= IDEAL_MAX_CHARS) return [sentence.trim()].filter(Boolean);
  const parts =
    sentence
      .match(/[^，,；;：:\n]+[，,；;：:\n]?/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [sentence.trim()].filter(Boolean);

  const out: string[] = [];
  let buf = "";
  for (const part of parts) {
    const next = `${buf}${part}`;
    if (buf && textLen(next) > IDEAL_MAX_CHARS) {
      out.push(buf);
      buf = part;
    } else {
      buf = next;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function splitScriptForScenes(script: string): string[] {
  const sentences =
    script
      .match(/[^。！？!?]+[。！？!?]?/g)
      ?.flatMap(splitLongSentence)
      .map((s) => s.trim())
      .filter(Boolean) ?? [script.trim()].filter(Boolean);

  const scenes: string[] = [];
  let buf = "";
  for (const sentence of sentences) {
    const next = `${buf}${sentence}`;
    if (buf && textLen(next) > IDEAL_MAX_CHARS) {
      scenes.push(buf);
      buf = sentence;
    } else {
      buf = next;
    }
  }
  if (buf) scenes.push(buf);

  while (scenes.length > MAX_SCENES) {
    let best = 0;
    let bestLen = Number.POSITIVE_INFINITY;
    for (let i = 0; i < scenes.length - 1; i++) {
      const mergedLen = textLen(scenes[i] + scenes[i + 1]);
      if (mergedLen < bestLen) {
        best = i;
        bestLen = mergedLen;
      }
    }
    scenes.splice(best, 2, scenes[best] + scenes[best + 1]);
  }

  while (scenes.length < MIN_SCENES) {
    let longest = -1;
    let longestLen = 0;
    for (let i = 0; i < scenes.length; i++) {
      const len = textLen(scenes[i]);
      if (len > longestLen) {
        longest = i;
        longestLen = len;
      }
    }
    if (longest < 0 || longestLen < 80) break;
    const text = scenes[longest];
    const mid = Math.floor(text.length / 2);
    let cut = text.indexOf("，", mid);
    if (cut < 0) cut = text.indexOf("。", mid);
    if (cut < 0 || cut >= text.length - 1) cut = mid;
    scenes.splice(longest, 1, text.slice(0, cut + 1), text.slice(cut + 1));
  }

  return scenes.map((s) => s.trim()).filter(Boolean);
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function shotType(index: number): string {
  return ["中景", "近景", "远景", "特写"][index % 4];
}

function buildVisual(text: string, index: number, total: number): string {
  const shot = shotType(index);
  const base = "竖屏9:16，中国水墨电影感，写实古风，低饱和色彩，画面干净，无字幕无文字";

  if (hasAny(text, ["中国文化1000问", "点击", "头像", "橱窗", "买回去", "床头", "沙发", "翻几页", "文化读物"])) {
    return `${shot}，现代中式客厅或书房里，一本《中国文化1000问》放在木桌、床头或沙发边，暖色台灯照亮书页，家人安静翻阅，氛围温和可信，${base}`;
  }
  if (hasAny(text, ["汉武帝", "朝堂", "满朝文武", "皇帝", "长安"])) {
    return `${shot}，西汉宫殿朝堂，汉武帝端坐高位，群臣低头沉默，司马迁孤身站在殿中进言，气氛压抑紧绷，冷暖对比光，${base}`;
  }
  if (hasAny(text, ["李陵", "匈奴", "俘虏", "粮草", "箭", "寡不敌众", "士兵"])) {
    return `${shot}，边塞荒漠战场，残旗、断箭和疲惫士兵散落在风沙里，将领回望远方，表现孤军苦战后的沉重与无力，${base}`;
  }
  if (hasAny(text, ["大牢", "宫刑", "判了重罪", "屈辱", "洗不掉"])) {
    return `${shot}，昏暗牢狱内，司马迁穿素色囚衣坐在墙边，地面斜落一束冷光，人物低头克制痛苦，画面庄重含蓄，${base}`;
  }
  if (hasAny(text, ["父亲", "临终", "承诺", "愿望", "儿子"])) {
    return `${shot}，昏黄灯火下的古代病榻，年迈父亲握住司马迁的手交代遗愿，案边堆着竹简，人物神情沉重而坚定，${base}`;
  }
  if (hasAny(text, ["太史令", "史书", "档案", "资料", "竹简", "整理", "核对", "修改", "写完", "五十二万"])) {
    return `${shot}，深夜史官书房，司马迁伏案整理竹简，一盏油灯照亮案卷和毛笔，窗外寂静，突出长期写作与守住使命，${base}`;
  }
  if (hasAny(text, ["屈原", "韩信", "刺客", "游侠", "商人", "将军", "谋士"])) {
    return `${shot}，展开的竹简上浮现多位历史人物剪影，将军、谋士、游侠与文人交错出现，像历史长卷缓缓铺开，厚重而有层次，${base}`;
  }
  if (hasAny(text, ["中年", "普通人", "上班", "做饭", "孩子", "老人", "责任", "生活", "低谷", "黑夜"])) {
    return `${shot}，现代普通家庭清晨或夜晚，成年人一边照顾家人一边整理衣物准备出门，神情疲惫但仍然坚持，暖光中带有现实质感，${base}`;
  }
  if (hasAny(text, ["人固有一死", "泰山", "鸿毛", "活下去", "不能死", "选择", "坚强", "体面"])) {
    return `${shot}，司马迁独坐在烛光前凝视竹简，身后是漫长阴影，人物表情隐忍坚定，画面突出人在绝境中做选择的重量，${base}`;
  }
  if (index >= total - 3) {
    return `${shot}，古代竹简与现代书桌形成转场，历史人物剪影渐渐隐入书页，最后落到安静阅读的人身上，情绪收束，庄重温暖，${base}`;
  }
  return `${shot}，西汉史官书房与宫墙外景交替，司马迁穿深色汉服行走或伏案，竹简、宫灯、长廊和冷色阴影构成压抑历史氛围，${base}`;
}

function buildDeterministicStoryboard(script: string): Storyboard {
  const scenes = splitScriptForScenes(script);
  return {
    scenes: scenes.map((text, i) => ({
      id: i + 1,
      text,
      visual: buildVisual(text, i, scenes.length),
      estDuration: estimateDuration(text),
    })),
  };
}

function validateStoryboardQuality(board: Storyboard): string | null {
  for (const scene of board.scenes) {
    const text = normalizeCoverageText(scene.text);
    const visual = normalizeCoverageText(scene.visual);
    if (textLen(scene.text) > HARD_MAX_CHARS) {
      return `scene ${scene.id} text too long: ${textLen(scene.text)} chars`;
    }
    if (scene.visual.trim().length < 28) {
      return `scene ${scene.id} visual too short`;
    }
    if (/historical narrative image matching this narration/i.test(scene.visual)) {
      return `scene ${scene.id} visual uses fallback template`;
    }
    const copied = text.slice(0, Math.min(36, text.length));
    if (copied.length >= 20 && visual.includes(copied)) {
      return `scene ${scene.id} visual copies narration`;
    }
  }
  return null;
}

export const storyboard: StepDef = {
  name: "storyboard",
  deps: ["rewrite"],
  output: "storyboard.json",
  run: async (ctx) => {
    const rw = rewriteSchema.parse(await ctx.readJSON("rewrite.json"));
    const prompt = await loadPrompt("storyboard", ctx.track);

    let board: Storyboard | null = null;
    if (ctx.mode === "mock") {
      board = buildDeterministicStoryboard(rw.script);
    } else {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        const { content, cost } = await chat(
          prompt.system,
          prompt.build({ script: rw.script }),
          ctx.mode,
          { json: true }
        );
        ctx.reportCost(cost, { provider: "llm", step: "storyboard" });
        try {
          const parsed = storyboardSchema.parse(await parseJsonRobust(content, ctx.mode));
          const coverage = validateScriptCoverage(
            rw.script,
            parsed.scenes.map((scene) => scene.text).join("")
          );
          if (!coverage.ok) throw new Error(coverage.reason);
          const qualityError = validateStoryboardQuality(parsed);
          if (qualityError) throw new Error(qualityError);
          board = parsed;
          break;
        } catch (e) {
          lastErr = e;
          ctx.log(`storyboard LLM output rejected (${attempt + 1}/3): ${e}`);
        }
      }
      if (!board) {
        ctx.log(`storyboard fallback: deterministic full-script split after LLM issue: ${lastErr}`);
        board = buildDeterministicStoryboard(rw.script);
      }
    }

    const coverage = validateScriptCoverage(
      rw.script,
      board.scenes.map((scene) => scene.text).join("")
    );
    if (!coverage.ok) {
      return { ok: false, error: `分镜没有覆盖完整文案: ${coverage.reason}` };
    }
    const qualityError = validateStoryboardQuality(board);
    if (qualityError) {
      return { ok: false, error: `分镜质量校验失败: ${qualityError}` };
    }

    await ctx.writeJSON("storyboard.json", board);
    const previousBookConfig = await loadBookShowcaseConfig(ctx.taskDir);
    const bookConfig = await buildBookShowcaseConfig(rw, board, previousBookConfig);
    await saveBookShowcaseConfig(ctx.taskDir, bookConfig);
    ctx.log(
      bookConfig.autoCandidateSceneId
        ? `书籍推荐候选: scene ${bookConfig.autoCandidateSceneId}（等待人工确认）`
        : "书籍推荐候选: 未识别到明确推荐语义，可手动选择或仅保留结尾"
    );
    ctx.log(`分镜: ${board.scenes.length} 个 scene`);
    return { ok: true };
  },
};

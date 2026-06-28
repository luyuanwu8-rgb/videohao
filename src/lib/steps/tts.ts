import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { StepDef } from "./types";
import { synthesize, synthesizeSilence, CensorshipError, estimateDuration } from "@/lib/providers/stepfun";
import { synthesizeVolc } from "@/lib/providers/volcengine";
import { chat } from "@/lib/providers/llm";
import { storyboardSchema, voiceSchema, voiceConfigSchema, type VoiceSegment } from "@/lib/domain";

/**
 * tts: 每个 scene 一段配音，记录真实时长。
 * 时长是 timeline 的"真相来源"——画面停多久由这里的配音长度决定。
 *
 * 双 provider：voice-config.json 指定 provider(volcengine/stepfun) + 音色 + 语速；
 * 缺省走火山「解说小明」。内容审核(451/风控)容错：LLM 改写一次再合成，仍失败静音占位。
 */

/** 按配置分发到对应 provider 合成 */
async function synth(
  text: string,
  dest: string,
  mode: "mock" | "real",
  cfg: { provider: string; voice: string; speed: number }
): Promise<{ duration: number }> {
  if (cfg.provider === "stepfun") {
    return synthesize(text, dest, mode, { voice: cfg.voice, speed: cfg.speed });
  }
  return synthesizeVolc(text, dest, mode, { voice: cfg.voice, speed: cfg.speed });
}

export const tts: StepDef = {
  name: "tts",
  deps: ["storyboard"],
  output: "voice.json",
  run: async (ctx) => {
    const board = storyboardSchema.parse(await ctx.readJSON("storyboard.json"));
    await mkdir(join(ctx.taskDir, "voice"), { recursive: true });

    // 读配音配置（面板写入，缺省用 schema 默认：火山解说小明）
    let cfg = voiceConfigSchema.parse({});
    try {
      cfg = voiceConfigSchema.parse(await ctx.readJSON("voice-config.json"));
    } catch {
      /* 无配置走默认 */
    }

    const segments: VoiceSegment[] = [];
    const blocked: number[] = [];
    let total = 0;

    for (const scene of board.scenes) {
      const rel = `voice/${scene.id}.mp3`;
      const dest = join(ctx.taskDir, rel);
      let duration: number;
      try {
        ({ duration } = await synth(scene.text, dest, ctx.mode, cfg));
      } catch (e) {
        if (!(e instanceof CensorshipError)) throw e;
        // 内容审核误杀：LLM 等义改写一次再合成
        const reworded = await rewordForCensorship(scene.text, ctx.mode).catch(() => null);
        let ok = false;
        if (reworded && reworded !== scene.text) {
          try {
            ({ duration } = await synth(reworded, dest, ctx.mode, cfg));
            ok = true;
            ctx.log(`镜头${scene.id} 审核拦截→改写后合成成功`);
          } catch (e2) {
            if (!(e2 instanceof CensorshipError)) throw e2;
          }
        }
        if (!ok) {
          duration = await synthesizeSilence(dest, estimateDuration(scene.text));
          blocked.push(scene.id);
          ctx.log(`镜头${scene.id} 审核拦截→改写无效，已用静音占位`);
        }
      }
      ctx.reportCost(0, { provider: cfg.provider, sceneId: scene.id });
      await ctx.registerArtifact(rel, { fileType: "mp3", meta: { sceneId: scene.id } });
      segments.push({ sceneId: scene.id, audioPath: rel, duration: duration! });
      total += duration!;
    }

    const voice = voiceSchema.parse({ segments, totalDuration: total });
    await ctx.writeJSON("voice.json", voice, { meta: { blocked, provider: cfg.provider, voice: cfg.voice } });
    ctx.log(
      `配音[${cfg.provider}/${cfg.voice}]: ${segments.length} 段, 共 ${total.toFixed(1)}s` +
        (blocked.length ? `（${blocked.length} 段被审核静音: ${blocked.join(",")}）` : "")
    );
    return { ok: true };
  },
};

/** 让 LLM 在不改变意思的前提下换个说法，绕开内容审核误杀 */
async function rewordForCensorship(text: string, mode: "mock" | "real"): Promise<string> {
  if (mode === "mock") return text;
  const { content } = await chat(
    "你是中文文案编辑。下面这句口播文案被语音合成的内容审核系统误判拦截了，但它本身无害。" +
      "请在完全保持原意和口语风格的前提下，替换可能触发审核的个别用词，重写成一句等义的话。只输出改写后的句子，不要解释。",
    text,
    "real",
    { temperature: 0.5 }
  );
  return content.trim().replace(/^["'「『]|["'」』]$/g, "");
}

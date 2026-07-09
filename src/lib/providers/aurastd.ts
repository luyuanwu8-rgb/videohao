import { env, type Mode } from "./base";
import { writeFile } from "node:fs/promises";
import { CensorshipError } from "./stepfun";
import { synthChunked } from "./ttsChunk";

/**
 * Aura Studio (tts.aurastd.com) — MiniMax TTS 转发服务。
 *
 * HTTP 接口:POST https://tts.aurastd.com/api/v1/tts
 *   鉴权头 `Authorization: Bearer <API_KEY>`(标准 Bearer)。
 *   请求体 MiniMax 格式:model + text + voice_setting{voice_id,speed,...} + audio_setting{format}。
 *   默认 output_format=hex,返回体 { audio: "<hex编码mp3>", status }。
 *
 * 复刻音色:把克隆好的 voice_id 直接填进 voice_setting.voice_id 即可(voices.ts 里登记)。
 * 语速 speed 范围 [0.5, 2.0]。
 */

const TTS_URL = () => env("AURA_TTS_URL", "https://tts.aurastd.com/api/v1/tts");

function creds(): { apiKey: string; model: string } {
  const apiKey = env("AURA_TTS_API_KEY", "");
  if (!apiKey) throw new Error("missing config/env: AURA_TTS_API_KEY");
  return { apiKey, model: env("AURA_TTS_MODEL", "speech-2.8-turbo") };
}

/** MiniMax voice_modify 声音效果器参数(全 0/空视为不启用) */
export interface VoiceModify {
  pitch?: number; // -100..100 低沉↔明亮
  intensity?: number; // -100..100 刚劲↔轻柔
  timbre?: number; // -100..100 浑厚↔清脆
  soundEffects?: string; // spacious_echo|auditorium_echo|lofi_telephone|robotic|""
}

export interface AuraOpts {
  voice?: string;
  speed?: number;
  vol?: number;
  pitch?: number; // voice_setting.pitch -12..12
  emotion?: string;
  voiceModify?: VoiceModify;
}

/**
 * 合成一段配音,写到 destPath。返回真实时长(秒)。
 * 与 volcengine.synthesizeVolc 同签名,便于 tts.ts 统一分发;额外接受 Aura 高级参数。
 */
export async function synthesizeAura(
  text: string,
  destPath: string,
  mode: Mode,
  opts?: AuraOpts
): Promise<{ duration: number; cost: number }> {
  if (mode === "mock") {
    await writeFile(destPath, Buffer.alloc(44)); // 占位
    return { duration: estimateDuration(text), cost: 0 };
  }
  const { apiKey, model } = creds();
  const voice = opts?.voice || env("AURA_TTS_VOICE", "");
  if (!voice) throw new Error("missing config/env: AURA_TTS_VOICE(未指定 voice_id)");
  const speed = clampSpeed(opts?.speed);
  const maxChars = Number(env("TTS_MAX_CHARS", "280"));

  // 透明切分:超长文本切块逐块合成再拼接,对上层透明(与火山一致)
  const { duration } = await synthChunked(text, destPath, maxChars, (t, d) =>
    synthAuraOne(t, d, { apiKey, model, voice, speed, opts: opts ?? {} })
  );
  return { duration, cost: 0 };
}

/** 声音效果器全默认(全 0 且无音效)时返回 undefined,避免下发无意义参数 */
function buildVoiceModify(vm?: VoiceModify): Record<string, unknown> | undefined {
  if (!vm) return undefined;
  const pitch = clampInt(vm.pitch, -100, 100);
  const intensity = clampInt(vm.intensity, -100, 100);
  const timbre = clampInt(vm.timbre, -100, 100);
  const fx = vm.soundEffects || "";
  if (pitch === 0 && intensity === 0 && timbre === 0 && !fx) return undefined;
  const out: Record<string, unknown> = { pitch, intensity, timbre };
  if (fx) out.sound_effects = fx;
  return out;
}

/** 单次合成(供 synthChunked 逐块调用):带超时+重试,返回真实时长 */
async function synthAuraOne(
  text: string,
  destPath: string,
  cfg: { apiKey: string; model: string; voice: string; speed: number; opts: AuraOpts }
): Promise<{ duration: number }> {
  const o = cfg.opts;
  const voiceSetting: Record<string, unknown> = {
    voice_id: cfg.voice,
    speed: cfg.speed,
    vol: clampNum(o.vol, 0, 10, 1),
    pitch: clampInt(o.pitch, -12, 12),
    emotion: o.emotion || "neutral",
  };
  const body: Record<string, unknown> = {
    model: cfg.model,
    text,
    stream: false,
    output_format: "hex",
    voice_setting: voiceSetting,
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
  };
  const vm = buildVoiceModify(o.voiceModify);
  if (vm) body.voice_modify = vm;

  const timeoutMs = Number(env("AURA_TTS_TIMEOUT_MS", "90000"));
  const maxRetry = Number(env("AURA_TTS_MAX_RETRY", "2"));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetch(TTS_URL(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        // 内容审核类(400/敏感)不重试,直接上抛给 tts.ts 走改写/静音兜底
        if (/敏感|风控|安全|审核|sensitive|risk|invalid text/i.test(t)) {
          throw new CensorshipError(`aura TTS 内容审核拦截: ${t.slice(0, 200)}`);
        }
        lastErr = new Error(`aura TTS HTTP ${resp.status}: ${t.slice(0, 200)}`);
      } else {
        const j = (await resp.json()) as { audio?: string; base_resp?: { status_code?: number; status_msg?: string } };
        // MiniMax 风格错误体:base_resp.status_code != 0
        const errMsg = j.base_resp?.status_code ? j.base_resp?.status_msg ?? "" : "";
        if (errMsg && /敏感|风控|安全|审核|sensitive|risk|invalid text/i.test(errMsg)) {
          throw new CensorshipError(`aura TTS 内容审核拦截: ${errMsg}`);
        }
        if (!j.audio) {
          lastErr = new Error(`aura TTS 无 audio 返回${errMsg ? `: ${errMsg}` : ""}`);
        } else {
          const buf = Buffer.from(j.audio, "hex"); // output_format=hex → hex 解码为 mp3
          await writeFile(destPath, buf);
          const probed = await probeDuration(destPath);
          return { duration: probed > 0 ? probed : estimateDuration(text) };
        }
      }
    } catch (e) {
      if (e instanceof CensorshipError) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxRetry) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(`aura TTS 失败: ${String(lastErr)}`);
}

/** MiniMax 语速合法区间 0.5~2.0,默认 1.0 */
function clampSpeed(v?: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 1.0;
  return Math.max(0.5, Math.min(2.0, v));
}

/** 数值夹取(非法回退 fallback) */
function clampNum(v: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

/** 整数夹取(非法回退 0) */
function clampInt(v: number | undefined, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/** 估算时长(探测失败兜底)——与其他 provider 一致的粗算 */
function estimateDuration(text: string, speed = 1.0): number {
  const cn = (text.match(/[一-鿿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z0-9]+/g) ?? []).length;
  const sec = (cn / 4.8 + latin / 2.4 + 0.6) / Math.max(speed, 0.2);
  return Math.max(1.2, Math.min(sec, 18));
}

/** ffprobe 探真实时长 */
async function probeDuration(path: string): Promise<number> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const ff = process.env.FFPROBE_PATH || "ffprobe";
    const child = spawn(ff, [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", path,
    ]);
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("close", () => {
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) ? n : 0);
    });
    child.on("error", () => resolve(0));
  });
}

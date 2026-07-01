import { env, type Mode } from "./base";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CensorshipError } from "./stepfun";
import { synthChunked } from "./ttsChunk";

/**
 * 火山引擎 语音合成大模型 TTS。
 *
 * HTTP 非流式接口：POST https://openspeech.bytedance.com/api/v1/tts
 *   鉴权头 `Authorization: Bearer;<token>`（注意分号，火山特有写法）。
 *   请求体 app/user/audio/request 四段；返回 data 是 base64 音频。
 *   code=3000 成功；语速 speed_ratio 0.2~3.0。
 *
 * 音色 voice_type 即 voices.ts 里的火山音色ID。
 */

const TTS_URL = "https://openspeech.bytedance.com/api/v1/tts";

function creds(): { appid: string; token: string; cluster: string } {
  const appid = env("VOLC_TTS_APPID", "");
  const token = env("VOLC_TTS_TOKEN", "");
  if (!appid || !token) throw new Error("missing env: VOLC_TTS_APPID / VOLC_TTS_TOKEN");
  return { appid, token, cluster: env("VOLC_TTS_CLUSTER", "volcano_tts") };
}

/**
 * 合成一段配音，写到 destPath。返回真实时长（秒）。
 * 与 stepfun.synthesize 同签名扩展：voice/speed 可选。
 */
export async function synthesizeVolc(
  text: string,
  destPath: string,
  mode: Mode,
  opts?: { voice?: string; speed?: number }
): Promise<{ duration: number; cost: number }> {
  if (mode === "mock") {
    await writeFile(destPath, Buffer.alloc(44)); // 占位
    return { duration: estimateDuration(text), cost: 0 };
  }
  const { appid, token, cluster } = creds();
  const voice = opts?.voice || env("VOLC_TTS_VOICE", "zh_male_jieshuoxiaoming_moon_bigtts");
  const speed = clampSpeed(opts?.speed);
  const maxChars = Number(env("TTS_MAX_CHARS", "280"));

  // 透明切分:超长文本切块逐块合成再拼接(阶段5),对上层透明
  const { duration } = await synthChunked(text, destPath, maxChars, (t, d) =>
    synthVolcOne(t, d, { appid, token, cluster, voice, speed })
  );
  return { duration, cost: 0 };
}

/** 单次合成(供 synthChunked 逐块调用):带超时,返回真实时长 */
async function synthVolcOne(
  text: string,
  destPath: string,
  cfg: { appid: string; token: string; cluster: string; voice: string; speed: number }
): Promise<{ duration: number }> {
  const body = {
    app: { appid: cfg.appid, token: cfg.token, cluster: cfg.cluster },
    user: { uid: "videohao" },
    audio: { voice_type: cfg.voice, encoding: "mp3", speed_ratio: cfg.speed },
    request: { reqid: randomUUID(), text, operation: "query" },
  };

  const timeoutMs = Number(env("VOLC_TTS_TIMEOUT_MS", "60000"));
  const maxRetry = Number(env("VOLC_TTS_MAX_RETRY", "2"));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetch(TTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer;${cfg.token}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        lastErr = new Error(`volc TTS HTTP ${resp.status}: ${t.slice(0, 200)}`);
      } else {
        const j = (await resp.json()) as { code?: number; message?: string; data?: string };
        if (j.code !== 3000 || !j.data) {
          const msg = j.message ?? "unknown";
          if (/敏感|风控|安全|审核|sensitive|risk|invalid text/i.test(msg)) {
            throw new CensorshipError(`volc TTS 内容审核拦截: ${msg}`); // 审核错误不重试,直接上抛
          }
          lastErr = new Error(`volc TTS code=${j.code}: ${msg}`);
        } else {
          const buf = Buffer.from(j.data, "base64");
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
  throw lastErr instanceof Error ? lastErr : new Error(`volc TTS 失败: ${String(lastErr)}`);
}

/** 语速合法区间 0.2~3.0，默认 1.0 */
function clampSpeed(v?: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 1.0;
  return Math.max(0.2, Math.min(3.0, v));
}

/** 估算时长（探测失败兜底）——与 stepfun 一致的粗算 */
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

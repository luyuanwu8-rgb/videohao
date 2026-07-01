import { env, type Mode } from "./base";
import { writeFile, readFile, rm } from "node:fs/promises";

/**
 * StepFun 云：TTS（文本→配音）+ ASR（音频→逐字稿）。
 *
 * ASR 走 SSE 流式接口（非 OpenAI 兼容）：POST {ASR_BASE}/audio/asr/sse
 *   模型 stepaudio-2.5-asr，请求体是 base64 音频 + 嵌套 JSON，响应是 SSE 事件流。
 *   接入方式对齐 Codex 里跑通的 stepaudio-playground/asr.mjs。
 * TTS 走 OpenAI 兼容 POST {TTS_BASE}/audio/speech。
 *
 * key 默认读 STEP_API_KEY（你已设在 Windows 环境变量），回退 STEPFUN_API_KEY。
 */

export interface AsrResult {
  text: string;
  language: string;
}

function stepKey(): string {
  const k = process.env.STEP_API_KEY || process.env.STEPFUN_API_KEY;
  if (!k) throw new Error("missing env: STEP_API_KEY (或 STEPFUN_API_KEY)");
  return k;
}

/**
 * 全局请求节流 gate（TTS + ASR 共用同一个 key，同受 RPM 限制）。
 * StepFun 免费档 10 RPM：默认最小间隔 6.5s/次，留余量避开 429。
 * 可用 STEP_MIN_INTERVAL_MS 覆盖（充值提额后可调小）。
 */
let gateChain: Promise<void> = Promise.resolve();
function minIntervalMs(): number {
  const v = Number(process.env.STEP_MIN_INTERVAL_MS);
  return Number.isFinite(v) && v > 0 ? v : 6500;
}
/** 排队取一个发射许可：保证两次请求间隔 ≥ minInterval */
function acquireSlot(): Promise<void> {
  const gap = minIntervalMs();
  const prev = gateChain;
  let release!: () => void;
  gateChain = new Promise<void>((r) => (release = r));
  return prev.then(async () => {
    await new Promise((r) => setTimeout(r, gap));
    release();
  });
}

/** 带 429 退避的 fetch：读 Retry-After，最多重试 maxRetry 次 */
async function fetchWithBackoff(
  url: string,
  init: RequestInit,
  maxRetry = 4
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await acquireSlot();
    const resp = await fetch(url, init);
    if (resp.status !== 429 || attempt >= maxRetry) return resp;
    // 429：优先用 Retry-After 头，否则指数退避（封顶 30s）
    const ra = Number(resp.headers.get("retry-after"));
    const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30000, 2000 * 2 ** attempt);
    await resp.body?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/** 解析 SSE 缓冲，返回完整事件和剩余未完成部分 */
function parseSse(buffer: string): { events: { event: string; data: string }[]; rest: string } {
  const events: { event: string; data: string }[] = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    const ev = { event: "message", data: "" };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) ev.event = line.slice(6).trim();
      if (line.startsWith("data:")) ev.data += line.slice(5).trim();
    }
    if (ev.data) events.push(ev);
  }
  return { events, rest };
}

function extractText(payload: Record<string, any>): string {
  const c = [
    payload?.text,
    payload?.result?.text,
    payload?.transcript,
    payload?.output?.text,
    payload?.data?.text,
    payload?.data?.result?.text,
    payload?.choices?.[0]?.text,
    payload?.choices?.[0]?.delta?.content,
  ];
  return c.find((v) => typeof v === "string" && v.length) ?? "";
}

/**
 * 转写音频 → 文字（transcribe 用）。
 *
 * 真实视频是 mp4 容器（几十 MB、几分钟）：直接把整片 base64 发 ASR 会返回空。
 * 所以先用 ffmpeg 抽音轨为 16k 单声道 wav，再按 ~60s 分片逐片转写、拼接。
 *   - 必须用 wav(pcm_s16le)：Windows 的 mp3_mf 编码器会静默产出空文件。
 *   - 分片绕开 ASR 单次时长/体积上限，任意长度视频都能转。
 */
export async function transcribe(
  audioPath: string,
  mode: Mode
): Promise<{ result: AsrResult; cost: number }> {
  if (mode === "mock") {
    return {
      result: {
        text:
          "很多人觉得睡前饿肚子是亏待自己其实刚好相反空腹入睡能启动细胞自噬和代谢修复",
        language: "zh",
      },
      cost: 0,
    };
  }

  const asrBase = (env("STEPFUN_ASR_BASE_URL", "https://api.stepfun.com/v1") || "").replace(/\/+$/, "");
  const model = env("STEPFUN_ASR_MODEL", "stepaudio-2.5-asr");
  const language = env("STEPFUN_ASR_LANG", "zh");
  const key = stepKey();

  // 1) 抽音轨 → 分片 wav（临时文件，转完即删）
  const chunks = await extractAudioChunks(audioPath, 60);
  if (chunks.length === 0) {
    throw new Error(`ffmpeg 未能从 ${audioPath} 抽出音轨（检查文件/ffmpeg）`);
  }

  // 2) 逐片转写（顺序，保证文本顺序），拼接
  const parts: string[] = [];
  try {
    for (const wav of chunks) {
      const text = await transcribeChunk(wav, { asrBase, model, language, key });
      if (text) parts.push(text);
    }
  } finally {
    await Promise.all(chunks.map((f) => rm(f, { force: true }).catch(() => {})));
  }

  const finalText = parts.join("");
  if (!finalText.trim()) {
    throw new Error(
      `ASR 转写结果为空（${chunks.length} 片均无文本）。可能音轨无声或 ASR 域名/模型不匹配。`
    );
  }
  return { result: { text: finalText, language }, cost: 0 };
}

/** 单片 wav → ASR 文本（SSE 流式，取最长文本） */
async function transcribeChunk(
  wavPath: string,
  cfg: { asrBase: string; model: string; language: string; key: string }
): Promise<string> {
  const audioB64 = (await readFile(wavPath)).toString("base64");
  const body = {
    audio: {
      data: audioB64,
      input: {
        transcription: { model: cfg.model, language: cfg.language, enable_itn: true },
        format: { type: "wav" },
      },
    },
  };

  // 整体超时:SSE 流式读取无超时会挂死(阶段5),超时则 abort
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(process.env.STEP_ASR_TIMEOUT_MS ?? "120000"));
  try {
    const resp = await fetchWithBackoff(`${cfg.asrBase}/audio/asr/sse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!resp.ok || !resp.body) {
      const t = await resp.text().catch(() => "");
      throw new Error(`stepfun ASR HTTP ${resp.status}: ${t.slice(0, 200)}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let finalText = "";
    for await (const chunk of resp.body as any) {
      buffer += decoder.decode(chunk, { stream: true });
      const parsed = parseSse(buffer);
      buffer = parsed.rest;
      for (const ev of parsed.events) {
        if (ev.data === "[DONE]") continue;
        try {
          const text = extractText(JSON.parse(ev.data));
          if (text && text.length >= finalText.length) finalText = text;
        } catch {
          /* 跳过非 JSON 事件 */
        }
      }
    }
    return finalText;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ffmpeg 抽音轨 → 16k 单声道 wav，按 segSeconds 切片。
 * 返回切片文件绝对路径数组（按时间顺序）。无音轨/失败返回 []。
 */
async function extractAudioChunks(videoPath: string, segSeconds: number): Promise<string[]> {
  const { spawn } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { mkdtemp, readdir } = await import("node:fs/promises");

  const baseTmp = process.env.VIDEOHAO_TMP || tmpdir();
  const dir = await mkdtemp(join(baseTmp, "asr-")).catch(async () =>
    // VIDEOHAO_TMP 可能不存在，回退到视频同目录
    mkdtemp(join(dirname(videoPath), "asr-"))
  );
  const pattern = join(dir, "chunk_%03d.wav");
  const ff = process.env.FFMPEG_PATH || "ffmpeg";

  const code = await new Promise<number>((resolve) => {
    const child = spawn(ff, [
      "-y",
      "-i", videoPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
      "-f", "segment",
      "-segment_time", String(segSeconds),
      pattern,
    ]);
    child.on("close", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });
  if (code !== 0) return [];

  const files = (await readdir(dir).catch(() => []))
    .filter((f) => f.endsWith(".wav"))
    .sort();
  return files.map((f) => join(dir, f));
}

function normalizeBaseUrl(base: string): string {
  const b = (base || "").replace(/\/+$/, "");
  if (b.endsWith("/v1")) return b;
  return b ? `${b}/v1` : "";
}

/** 估算时长（秒）——mock 用，real 模式由音频探测覆盖 */
export function estimateDuration(text: string, speed = 1.0): number {
  const cn = (text.match(/[一-鿿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z0-9]+/g) ?? []).length;
  const sec = (cn / 4.8 + latin / 2.4 + 0.6) / Math.max(speed, 0.2);
  return Math.max(1.2, Math.min(sec, 18));
}

/** TTS 内容审核拦截（451）：可被上层识别以触发"改写重试 / 静音跳过" */
export class CensorshipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CensorshipError";
  }
}

/**
 * 生成一段指定秒数的静音 mp3（用 ffmpeg）。
 * 用于某段配音被审核误杀且改写仍失败时占位，保证时间线不塌。
 */
export async function synthesizeSilence(destPath: string, seconds: number): Promise<number> {
  const { spawn } = await import("node:child_process");
  const ff = process.env.FFMPEG_PATH || "ffmpeg";
  const dur = Math.max(0.5, seconds);
  const code = await new Promise<number>((resolve) => {
    const child = spawn(ff, [
      "-y",
      "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=mono",
      "-t", String(dur),
      "-q:a", "9",
      destPath,
    ]);
    child.on("close", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });
  if (code !== 0) {
    // ffmpeg 不可用时退回最小 wav 头（极端兜底）
    await writeFile(destPath, mockWavHeader());
  }
  return dur;
}

/** 合成一段配音，写到 destPath。返回真实时长（秒）。 */
export async function synthesize(
  text: string,
  destPath: string,
  mode: Mode,
  opts?: { voice?: string; speed?: number }
): Promise<{ duration: number; cost: number }> {
  if (mode === "mock") {
    // 写一个占位 wav 头（44 字节静音），时长用估算
    await writeFile(destPath, mockWavHeader());
    return { duration: estimateDuration(text), cost: 0 };
  }
  const base = normalizeBaseUrl(env("STEPFUN_TTS_BASE_URL", "https://api.stepfun.com/v1"));
  const key = stepKey();
  const model = env("STEPFUN_TTS_MODEL", "step-tts-mini");
  const voice = opts?.voice || env("STEPFUN_TTS_VOICE", "cixingnansheng");
  const speed = typeof opts?.speed === "number" ? Math.max(0.5, Math.min(2, opts.speed)) : undefined;

  // OpenAI 兼容 POST /audio/speech
  const resp = await fetchWithBackoff(`${base}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: "mp3",
      ...(speed ? { speed } : {}),
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    // 451 + censorship_blocked：内容审核误杀，单独成可识别错误，供上层改写重试
    if (resp.status === 451 || t.includes("censorship_blocked")) {
      throw new CensorshipError(`stepfun TTS 内容审核拦截: ${t.slice(0, 160)}`);
    }
    throw new Error(`stepfun synthesize HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  const bytes = Buffer.from(await resp.arrayBuffer());
  await writeFile(destPath, bytes);

  // ffprobe 探测真实时长，失败则回退估算
  const probed = await probeDuration(destPath);
  return { duration: probed > 0 ? probed : estimateDuration(text), cost: 0 };
}

/** 用 ffprobe 读音频真实时长（秒）；不可用或失败返回 0 */
async function probeDuration(path: string): Promise<number> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const ff = process.env.FFPROBE_PATH || "ffprobe";
    const child = spawn(ff, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
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

function mockWavHeader(): Buffer {
  // 最小合法 wav 头（无音频数据），仅占位让产物存在
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(0, 40);
  return buf;
}

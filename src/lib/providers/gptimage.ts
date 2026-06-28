import { env, requireEnv, type Mode } from "./base";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

/**
 * gpt-image 生图 provider。
 *
 * 两种用法：
 *   generate()      —— 单图（保留给 test-image / 旧调用）。
 *   generateGrid()  —— 九宫格省钱方案：一次出 3×3 网格图，再用 sliceGrid 裁成 9 张。
 *
 * 真实接口走 POST /images/generations（yunwu.ai 中转，gpt-image-2）。
 * gpt-image-2 在中转上接受任意尺寸字符串；裁切一律按 ffprobe 探到的真实像素 ÷3，
 * 即便中转把尺寸 clamp 了也不会错位。
 */

/** 向接口请求一张图，返回 PNG buffer + 成本。size 直接透传给 API。 */
async function requestImage(
  prompt: string,
  sizeStr: string
): Promise<{ buf: Buffer; cost: number }> {
  const base = normalizeBaseUrl(env("GPTIMAGE_BASE_URL", "https://api.openai.com/v1"));
  const key = requireEnv("GPTIMAGE_API_KEY");
  const model = env("GPTIMAGE_MODEL", "gpt-image-1");

  // gpt-image-2 出图慢(实测单图 ~44s)，undici 默认超时会抛 "fetch failed"。
  // 显式长超时 + 失败重试，避免长耗时请求被底层中断。
  const timeoutMs = Number(env("GPTIMAGE_TIMEOUT_MS", "180000"));
  const maxRetry = Number(env("GPTIMAGE_MAX_RETRY", "2"));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, prompt, size: sizeStr, n: 1 }),
        signal: ac.signal,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(`gptimage generate HTTP ${resp.status}: ${t.slice(0, 200)}`);
      }
      // 中转限流/网关错误时可能返回 HTML 首页而非 JSON —— 显式识别，避免 JSON.parse 抛晦涩错误
      const ctype = resp.headers.get("content-type") ?? "";
      if (!ctype.includes("json")) {
        const t = await resp.text().catch(() => "");
        throw new Error(`gptimage 返回非 JSON(疑似中转限流/网关页): ${t.slice(0, 120)}`);
      }
      const json = (await resp.json()) as {
        data?: { b64_json?: string; url?: string }[];
      };
      const item = json.data?.[0];
      let buf: Buffer;
      if (item?.b64_json) {
        buf = Buffer.from(item.b64_json, "base64");
      } else if (item?.url) {
        const img = await fetch(item.url);
        if (!img.ok) throw new Error(`下载生成图失败 HTTP ${img.status}`);
        buf = Buffer.from(await img.arrayBuffer());
      } else {
        throw new Error("gptimage 响应缺少 b64_json / url");
      }
      const cost = Number(env("GPTIMAGE_PRICE_PER_IMAGE", "0"));
      return { buf, cost };
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // HTTP 4xx(非限流)是确定性失败，不重试；网络/超时/5xx 才重试
      const retryable =
        msg.includes("fetch failed") ||
        msg.includes("aborted") ||
        msg.includes("timeout") ||
        msg.includes("ECONN") ||
        /HTTP 5\d\d/.test(msg) ||
        msg.includes("非 JSON");
      if (attempt >= maxRetry || !retryable) break;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 单图生成。9:16 等竖图映射到接口尺寸档。 */
export async function generate(
  prompt: string,
  destPath: string,
  size: { width: number; height: number },
  mode: Mode
): Promise<{ cost: number }> {
  if (mode === "mock") {
    await writeFile(destPath, MOCK_PNG);
    return { cost: 0 };
  }
  const { buf, cost } = await requestImage(prompt, pickSize(size));
  await writeFile(destPath, buf);
  return { cost };
}

/**
 * 九宫格生成：按 sizeStr 出一张 3×3 网格图，写到 destGridPath。
 * sizeStr 形如 "1024x1536"。整张网格图比例 = 单格比例。
 */
export async function generateGrid(
  prompt: string,
  destGridPath: string,
  sizeStr: string,
  mode: Mode
): Promise<{ cost: number }> {
  if (mode === "mock") {
    await writeFile(destGridPath, MOCK_PNG);
    return { cost: 0 };
  }
  const { buf, cost } = await requestImage(prompt, sizeStr);
  await writeFile(destGridPath, buf);
  return { cost };
}

/**
 * 把一张 3×3 网格图裁成 9 张单格，按 row-major(左上→右下)写入 destPaths。
 * destPaths 长度 ≤9：只裁前 N 格（最后一批 scene 不足 9 个时省心）。
 *
 * 关键：不按固定三等分硬切（模型画的白色分隔带位置每图各异，漂移可达 ±70px）。
 * 而是**实测**每张图的白色分隔带位置：在 1/3、2/3 附近的窗口内找"整行/整列接近全白"
 * 的带子作为真实切线，按带子边界裁内容。约束窗口能自动忽略画面内部的白色误判。
 */
export async function sliceGrid(
  gridPath: string,
  destPaths: string[],
  mode: Mode
): Promise<void> {
  if (mode === "mock") {
    for (const p of destPaths) await writeFile(p, MOCK_PNG);
    return;
  }
  const { width: W, height: H } = await probeSize(gridPath);
  const gray = await toGrayBuffer(gridPath, W, H);

  // 实测两条竖切带、两条横切带（返回每条带的 [起, 止] 像素范围）
  const vBands = [detectBand(gray, W, H, "col", W / 3), detectBand(gray, W, H, "col", (2 * W) / 3)];
  const hBands = [detectBand(gray, W, H, "row", H / 3), detectBand(gray, W, H, "row", (2 * H) / 3)];

  // 由白带边界推出 3 段内容区间（去掉白带本身），再各内收 2px 防边缘锯齿
  const pad = 2;
  const colRanges = bandsToRanges(vBands, W, pad);
  const rowRanges = bandsToRanges(hBands, H, pad);

  for (let i = 0; i < destPaths.length && i < 9; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const [x0, x1] = colRanges[col];
    const [y0, y1] = rowRanges[row];
    const cw = Math.max(1, x1 - x0);
    const ch = Math.max(1, y1 - y0);
    await runFfmpeg([
      "-y",
      "-i",
      gridPath,
      "-vf",
      `crop=${cw}:${ch}:${x0}:${y0}`,
      destPaths[i],
    ]);
  }
}

/** 灰度像素 buffer（一字节一像素，row-major） */
function toGrayBuffer(path: string, w: number, h: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-y", "-i", path, "-vf", "format=gray", "-f", "rawvideo", "-"],
      { shell: process.platform === "win32" }
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length < w * h) {
        return reject(new Error(`灰度抽取失败 code=${code} len=${buf.length}/${w * h}`));
      }
      resolvePromise(buf);
    });
  });
}

/**
 * 在 center 附近 ±12% 窗口内找白色分隔带，返回带子像素范围 [start, end]。
 * 先定位白占比峰值列/行，再向两侧扩展到白占比仍高的相邻线，得到带宽。
 */
function detectBand(
  gray: Buffer,
  W: number,
  H: number,
  axis: "col" | "row",
  center: number
): [number, number] {
  const len = axis === "col" ? W : H;
  const WHITE = 225;
  const frac = (i: number): number => {
    let c = 0;
    if (axis === "col") {
      for (let y = 0; y < H; y++) if (gray[y * W + i] > WHITE) c++;
      return c / H;
    } else {
      for (let x = 0; x < W; x++) if (gray[i * W + x] > WHITE) c++;
      return c / W;
    }
  };
  const win = Math.round(len * 0.12);
  const lo = Math.max(0, Math.round(center) - win);
  const hi = Math.min(len - 1, Math.round(center) + win);
  let peak = Math.round(center);
  let pf = -1;
  for (let i = lo; i <= hi; i++) {
    const f = frac(i);
    if (f > pf) {
      pf = f;
      peak = i;
    }
  }
  // 峰值过低（没画出白带）→ 退回理论切线 0 宽带，至少不崩
  if (pf < 0.5) return [peak, peak];
  // 从峰值向两侧扩展到白占比 ≥ 峰值一半
  const thr = Math.max(0.4, pf * 0.5);
  let s = peak;
  let e = peak;
  while (s > lo && frac(s - 1) >= thr) s--;
  while (e < hi && frac(e + 1) >= thr) e++;
  return [s, e];
}

/** 两条带 → 3 段内容区间。content = 白带之间的部分，各内收 pad。 */
function bandsToRanges(
  bands: [number, number][],
  len: number,
  pad: number
): [number, number][] {
  const [b1, b2] = bands;
  return [
    [pad, Math.max(pad + 1, b1[0] - pad)],
    [b1[1] + pad, Math.max(b1[1] + pad + 1, b2[0] - pad)],
    [b2[1] + pad, len - pad],
  ];
}

/** ffprobe 探图片真实像素 */
function probeSize(path: string): Promise<{ width: number; height: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        path,
      ],
      { shell: process.platform === "win32" }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe 退出码 ${code}`));
      const [w, h] = out.trim().split(",").map((n) => parseInt(n, 10));
      if (!w || !h) return reject(new Error(`ffprobe 无法解析尺寸: "${out.trim()}"`));
      resolvePromise({ width: w, height: h });
    });
  });
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ffmpeg", args, { shell: process.platform === "win32" });
    let err = "";
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(-200)}`));
      else resolvePromise();
    });
  });
}

/** 把竖图请求映射到 gpt-image 支持的最接近档位 */
function pickSize(size: { width: number; height: number }): string {
  const portrait = size.height >= size.width;
  return portrait ? "1024x1536" : "1536x1024";
}

function normalizeBaseUrl(base: string): string {
  const b = (base || "").replace(/\/+$/, "");
  if (b.endsWith("/v1")) return b;
  return b ? `${b}/v1` : "";
}

// 最小 1x1 PNG 占位
const MOCK_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082",
  "hex"
);

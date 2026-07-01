import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * TTS 透明切分(阶段5)—— 把"单次输入长度限制"当作 provider 内部问题,对上层透明。
 *
 * 文本超阈值时在标点处切成子块、逐块合成、ffmpeg 拼成该句一个 mp3。
 * 上层拿到的仍是"一句一个音频文件",不需知道底层切过。也顺带修"超限直接失败"的潜在 bug。
 */

/** 在标点处把长文本切成 ≤maxChars 的块;单块仍超长则硬切 */
export function splitForTts(text: string, maxChars: number): string[] {
  const t = (text ?? "").trim();
  if (t.length <= maxChars) return [t];
  const segs = t.split(/(?<=[。！？，、；;.!?])/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const seg of segs) {
    if (seg.length > maxChars) {
      if (cur) { out.push(cur); cur = ""; }
      for (let i = 0; i < seg.length; i += maxChars) out.push(seg.slice(i, i + maxChars));
      continue;
    }
    if ((cur + seg).length > maxChars && cur) { out.push(cur); cur = ""; }
    cur += seg;
  }
  if (cur) out.push(cur);
  return out.length ? out : [t];
}

/** ffmpeg 把多个音频片段按序拼成一个文件(同为mp3可直接 concat) */
function ffmpegConcat(parts: string[], dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const listPath = join(dirname(dest), `_ttsconcat_${Date.now()}.txt`);
    const list = parts.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
    writeFile(listPath, list, "utf-8").then(() => {
      const ff = process.env.FFMPEG_PATH || "ffmpeg";
      const child = spawn(ff, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", dest],
        { shell: process.platform === "win32" });
      let err = "";
      child.stderr.on("data", (d) => { err += String(d); });
      child.on("error", reject);
      child.on("close", async (code) => {
        await rm(listPath, { force: true }).catch(() => {});
        code === 0 ? resolve() : reject(new Error(`ffmpeg concat 退出码 ${code}: ${err.slice(-160)}`));
      });
    }).catch(reject);
  });
}

/**
 * 透明切分合成:text 超 maxChars 时切块逐块合成再拼接;否则直接单次合成。
 * synthOne(text, dest) 由各 provider 提供(单次合成,返回真实时长)。
 */
export async function synthChunked(
  text: string,
  dest: string,
  maxChars: number,
  synthOne: (t: string, d: string) => Promise<{ duration: number }>
): Promise<{ duration: number }> {
  const chunks = splitForTts(text, maxChars);
  if (chunks.length <= 1) return synthOne(text, dest);

  const tmps: string[] = [];
  let total = 0;
  try {
    for (let i = 0; i < chunks.length; i++) {
      const tmp = `${dest}.part${i}.mp3`;
      const { duration } = await synthOne(chunks[i], tmp);
      tmps.push(tmp);
      total += duration;
    }
    await ffmpegConcat(tmps, dest);
    return { duration: total };
  } finally {
    await Promise.all(tmps.map((t) => rm(t, { force: true }).catch(() => {})));
  }
}

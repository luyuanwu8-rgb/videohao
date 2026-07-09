import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { Timeline } from "@/lib/timeline";

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
};

type ProbeResult = {
  streams?: ProbeStream[];
  format?: {
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
};

export type RenderValidationResult = {
  ok: boolean;
  error?: string;
};

export async function validateRenderedVideo(input: {
  filePath: string;
  timeline: Timeline;
  log: (msg: string) => void;
}): Promise<RenderValidationResult> {
  const { filePath, timeline, log } = input;
  const expectedAudio = timeline.tracks.some((t) => t.type === "audio");
  const mode = (process.env.RENDER_VALIDATE || "strict").toLowerCase();

  const size = (await stat(filePath).catch(() => null))?.size ?? 0;
  const minSize = Math.max(10 * 1024, Math.round(timeline.duration * 1000));
  if (size < minSize) {
    return { ok: false, error: `成片文件过小: ${size} bytes，预期至少 ${minSize} bytes` };
  }

  const probe = await ffprobeJson(filePath);
  if (!probe.ok) return { ok: false, error: probe.error };

  const video = probe.data.streams?.find((s) => s.codec_type === "video");
  if (!video) return { ok: false, error: "成片缺少视频轨" };
  if (video.codec_name && video.codec_name !== "h264") {
    log(`成片验收:视频编码 ${video.codec_name}(非 h264，但继续按可解码性验收)`);
  }
  if (video.width !== timeline.width || video.height !== timeline.height) {
    return {
      ok: false,
      error: `成片分辨率不符: ${video.width}x${video.height}，预期 ${timeline.width}x${timeline.height}`,
    };
  }

  const fps = parseRate(video.avg_frame_rate || video.r_frame_rate || "");
  if (fps > 0 && Math.abs(fps - timeline.fps) > 0.5) {
    return { ok: false, error: `成片帧率不符: ${fps.toFixed(3)}fps，预期 ${timeline.fps}fps` };
  }

  const formatDuration = toNum(probe.data.format?.duration);
  const videoDuration = toNum(video.duration) || formatDuration;
  const duration = formatDuration || videoDuration;
  const tolerance = durationTolerance(timeline.duration);
  if (!duration || Math.abs(duration - timeline.duration) > tolerance) {
    return {
      ok: false,
      error: `成片时长不符: ${duration ? duration.toFixed(2) : "未知"}s，预期 ${timeline.duration.toFixed(2)}s，容差 ±${tolerance.toFixed(2)}s`,
    };
  }

  const nbFrames = toNum(video.nb_frames);
  if (nbFrames > 0) {
    const expectedFrames = timeline.duration * timeline.fps;
    const frameTolerance = Math.max(timeline.fps * tolerance, timeline.fps * 2);
    if (nbFrames + frameTolerance < expectedFrames) {
      return {
        ok: false,
        error: `成片帧数明显不足: ${Math.round(nbFrames)} 帧，预期约 ${Math.round(expectedFrames)} 帧`,
      };
    }
  }

  const audio = probe.data.streams?.find((s) => s.codec_type === "audio");
  if (expectedAudio) {
    if (!audio) return { ok: false, error: "成片缺少音频轨" };
    const audioDuration = toNum(audio.duration) || formatDuration;
    if (!audioDuration || Math.abs(audioDuration - timeline.duration) > tolerance) {
      return {
        ok: false,
        error: `成片音频时长不符: ${audioDuration ? audioDuration.toFixed(2) : "未知"}s，预期 ${timeline.duration.toFixed(2)}s`,
      };
    }
  }

  if (mode === "fast") {
    log("成片验收通过(fast):已校验 ffprobe/时长/轨道/分辨率，跳过全量解码");
    return { ok: true };
  }

  const videoDecode = await ffmpegDecode(filePath, "0:v:0");
  if (!videoDecode.ok) return { ok: false, error: `视频码流解码失败: ${videoDecode.error}` };

  if (mode !== "standard" && expectedAudio) {
    const audioDecode = await ffmpegDecode(filePath, "0:a:0");
    if (!audioDecode.ok) return { ok: false, error: `音频码流解码失败: ${audioDecode.error}` };
  } else if (mode === "standard") {
    log("成片验收(standard):已完成视频全量解码，跳过音频全量解码");
  }

  log(
    `成片验收通过: ${duration.toFixed(2)}s / ${video.width}x${video.height} / ${fps > 0 ? fps.toFixed(2) : "?"}fps / ${(size / 1024 / 1024).toFixed(1)}MB`
  );
  return { ok: true };
}

function durationTolerance(seconds: number): number {
  return Math.max(2, Math.min(6, seconds * 0.015));
}

function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
}

function parseRate(rate: string): number {
  const [a, b] = rate.split("/").map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return a / b;
}

async function ffprobeJson(filePath: string): Promise<{ ok: true; data: ProbeResult } | { ok: false; error: string }> {
  const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath];
  const r = await run(ffprobe, args);
  if (r.code !== 0) return { ok: false, error: `ffprobe 失败: ${r.stderr.slice(-800) || `退出码 ${r.code}`}` };
  try {
    return { ok: true, data: JSON.parse(r.stdout) as ProbeResult };
  } catch (e) {
    return { ok: false, error: `ffprobe JSON 解析失败: ${e instanceof Error ? e.message : e}` };
  }
}

async function ffmpegDecode(filePath: string, map: string): Promise<{ ok: boolean; error?: string }> {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const r = await run(ffmpeg, ["-v", "error", "-i", filePath, "-map", map, "-f", "null", "-"]);
  if (r.code === 0 && !r.stderr.trim()) return { ok: true };
  return { ok: false, error: (r.stderr.trim() || `退出码 ${r.code}`).slice(-1200) };
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

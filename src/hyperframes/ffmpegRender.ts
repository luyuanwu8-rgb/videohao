import { join, dirname, resolve } from "node:path";
import { writeFile, mkdir, copyFile, rm, rename, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Timeline } from "@/lib/timeline";
import { motionPreset, DEFAULT_MOTION } from "@/lib/motions";
import type { RenderInput, RenderResult } from "./render";

/**
 * FFmpeg 原生渲染后端(阶段3)—— 主渲染路径。
 *
 * 为什么用 FFmpeg 而非无头 Chrome 逐帧截图:秒级、无网络依赖(不要 GSAP CDN / npx)、确定性、
 * 画质与 HyperFrames 持平(同字体同缩放同滤镜)。V1 已实证全部原语在本机可行。
 *
 * 关键手法:
 * - 累积帧法:frameStart[i]=round(累计秒*fps),帧数取差值 → 边界误差≤1帧且不累积,音画不渐进失步。
 * - 逐片渲染 → concat demuxer 拼接:避开巨型 filtergraph 命令行长度限制,可断点。
 * - cover 复刻:scale(force_original_aspect_ratio=increase)+crop 居中,等价 object-fit:cover。
 * - 消抖:源先超采样(ss 倍)再 zoompan 缩回,消除低分辨率整数采样抖动。
 * - ass 中文字幕:cwd=work + 相对路径 + fontsdir=.(V1 实证绕过 Windows 路径转义)。
 * - 缺图黑帧兜底:引用的图缺失时用黑场,渲染永不崩。
 * - 原子写:先写临时再 rename,防渲染中被读到半成品。
 */

function templateDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "template");
}

/** ass 时间戳 H:MM:SS.cc */
function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cc = Math.round((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cc).padStart(2, "0")}`;
}

/** ass 事件文本转义(去掉会被 libass 解释的 { } 和换行) */
function assText(t: string): string {
  return t.replace(/[{}]/g, "").replace(/\r?\n/g, " ").trim();
}

/** ass 颜色 &HAABBGGRR(输入 #RRGGBB) */
function assColor(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || "#FFDE00");
  const rgb = m ? m[1] : "FFDE00";
  const r = rgb.slice(0, 2), g = rgb.slice(2, 4), b = rgb.slice(4, 6);
  const a = alpha.toString(16).padStart(2, "0").toUpperCase();
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** CSS filter(motion 预设)→ ffmpeg 滤镜串。支持 saturate/contrast/brightness/sepia。 */
function cssFilterToFfmpeg(css: string): string {
  if (!css) return "";
  const num = (re: RegExp): number | null => {
    const m = re.exec(css);
    return m ? parseFloat(m[1]) : null;
  };
  const sat = num(/saturate\(([\d.]+)\)/);
  const con = num(/contrast\(([\d.]+)\)/);
  const bri = num(/brightness\(([\d.]+)\)/);
  const sep = num(/sepia\(([\d.]+)\)/);

  const parts: string[] = [];
  const eq: string[] = [];
  if (sat != null) eq.push(`saturation=${sat}`);
  if (con != null) eq.push(`contrast=${con}`);
  if (bri != null) eq.push(`brightness=${(bri - 1).toFixed(3)}`); // CSS乘性≈ffmpeg加性近似
  if (eq.length) parts.push(`eq=${eq.join(":")}`);

  if (sep != null && sep > 0) {
    const a = Math.min(1, sep);
    const mix = (i: number, s: number) => (i * (1 - a) + s * a).toFixed(3);
    // 标准 sepia 矩阵按 a 与单位阵混合
    const rr = mix(1, 0.393), rg = mix(0, 0.769), rb = mix(0, 0.189);
    const gr = mix(0, 0.349), gg = mix(1, 0.686), gb = mix(0, 0.168);
    const br = mix(0, 0.272), bg = mix(0, 0.534), bb = mix(1, 0.131);
    parts.push(`colorchannelmixer=rr=${rr}:rg=${rg}:rb=${rb}:gr=${gr}:gg=${gg}:gb=${gb}:br=${br}:bg=${bg}:bb=${bb}`);
  }
  return parts.join(",");
}

function runFf(args: string[], cwd: string, log: (m: string) => void): Promise<number> {
  return new Promise((res) => {
    const env = { ...process.env };
    const tmpRoot = process.env.VIDEOHAO_TMP;
    if (tmpRoot) { env.TEMP = tmpRoot; env.TMP = tmpRoot; }
    const ff = process.env.FFMPEG_PATH || "ffmpeg";
    const child = spawn(ff, args, { cwd, env, shell: process.platform === "win32" });
    let err = "";
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", (e) => { log(`ffmpeg spawn 失败: ${e.message}`); res(1); });
    child.on("close", (code) => {
      if (code !== 0) log(`ffmpeg 退出码 ${code}: ${err.slice(-300)}`);
      res(code ?? 1);
    });
  });
}

/** 渲染单张图为一段 clip(zoompan+fade+滤镜);缺图用黑场兜底 */
async function renderClip(
  o: { work: string; srcAbs: string; outName: string; frames: number; W: number; H: number; fps: number;
       zoomFrom: number; zoomTo: number; fadeIn: number; colorFilter: string; ss: number; x264preset: string },
  log: (m: string) => void
): Promise<boolean> {
  const frames = Math.max(1, o.frames);
  const SW = Math.round(o.W * o.ss);
  const SH = Math.round(o.H * o.ss);
  const denom = Math.max(1, frames - 1);
  const zexpr = `min(${o.zoomFrom}+(${(o.zoomTo - o.zoomFrom).toFixed(4)})*on/${denom}\\,${o.zoomTo})`;
  const fade = o.fadeIn > 0 ? `fade=t=in:st=0:d=${Math.min(o.fadeIn, frames / o.fps / 2).toFixed(2)},` : "";
  const color = o.colorFilter ? o.colorFilter + "," : "";

  let args: string[];
  if (existsSync(o.srcAbs)) {
    // 消抖关键:zoompan 在超采样分辨率(SW×SH)上做,输出也是 SW×SH,再 lanczos 降采样到 W×H。
    // 降采样把每帧亚像素平移的 ±1px 抖动平均掉 → 丝滑。直接在 1x 上 zoompan 会抖。
    const vf =
      `scale=${SW}:${SH}:force_original_aspect_ratio=increase,crop=${SW}:${SH},` +
      `zoompan=z='${zexpr}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${SW}x${SH}:fps=${o.fps},` +
      `scale=${o.W}:${o.H}:flags=lanczos,` +
      fade + color + `format=yuv420p`;
    args = ["-y", "-loglevel", "error", "-i", o.srcAbs, "-vf", vf, "-frames:v", String(frames),
            "-r", String(o.fps), "-c:v", "libx264", "-preset", o.x264preset, "-pix_fmt", "yuv420p", o.outName];
  } else {
    // 缺图 → 黑场兜底,渲染不崩
    log(`缺图,用黑场兜底: ${o.srcAbs}`);
    args = ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=${o.W}x${o.H}:r=${o.fps}`,
            "-frames:v", String(frames), "-c:v", "libx264", "-preset", o.x264preset, "-pix_fmt", "yuv420p", o.outName];
  }
  const code = await runFf(args, o.work, log);
  return code === 0;
}

export async function renderTimelineFfmpeg(input: RenderInput): Promise<RenderResult> {
  const { timeline, taskDir, outRel, mode, log } = input;
  const outPath = join(taskDir, outRel);
  await mkdir(dirname(outPath), { recursive: true }); // 顺带修 render mock ENOENT 类问题

  if (mode === "mock") {
    await writeFile(outPath, Buffer.from(`MOCK MP4 (ffmpeg backend)\nduration=${timeline.duration}s\n`, "utf-8"));
    log(`mock 渲染(ffmpeg后端):占位 ${outRel}`);
    return { ok: true, note: "mock" };
  }

  const { width: W, height: H, fps } = timeline;
  const preset = motionPreset(timeline.motion ?? DEFAULT_MOTION);
  const colorFilter = cssFilterToFfmpeg(preset.filter);
  const ss = Number(process.env.FFRENDER_SUPERSAMPLE ?? "2"); // 消抖超采样倍数(2x zoompan 再降采样)
  const x264preset = process.env.FFRENDER_X264_PRESET || "medium";

  const work = join(taskDir, "renders", `ffwork-${Date.now()}`);
  await mkdir(work, { recursive: true });
  try {
    // 打包字体进 work(cwd=work + 相对路径,绕过 Windows 字幕路径转义)
    const fontSrc = join(templateDir(), "assets", "fonts", "simhei.ttf");
    if (existsSync(fontSrc)) await copyFile(fontSrc, join(work, "simhei.ttf"));

    const imgClips = timeline.tracks.filter((t) => t.type === "image") as Array<
      Extract<Timeline["tracks"][number], { type: "image" }>
    >;
    if (imgClips.length === 0) return { ok: false, error: "timeline 无图像轨,无法渲染" };

    // 1) 累积帧法:边界帧号取整,帧数=差值(不累积漂移)
    log(`FFmpeg 渲染: ${imgClips.length} 段图 / ${fps}fps / ${W}x${H} / 动效 ${preset.key} / ss=${ss}`);
    const clipNames: string[] = [];
    for (let i = 0; i < imgClips.length; i++) {
      const c = imgClips[i];
      const startFrame = Math.round(c.start * fps);
      const endFrame = Math.round((c.start + c.duration) * fps);
      const frames = Math.max(1, endFrame - startFrame);
      const outName = `clip_${String(i).padStart(4, "0")}.mp4`;
      const ok = await renderClip(
        { work, srcAbs: join(taskDir, c.src), outName, frames, W, H, fps,
          zoomFrom: c.zoom?.from ?? preset.zoom.from, zoomTo: c.zoom?.to ?? preset.zoom.to,
          fadeIn: preset.fadeIn, colorFilter, ss, x264preset },
        log
      );
      if (!ok) return { ok: false, error: `第 ${i} 段图渲染失败` };
      clipNames.push(outName);
    }

    // 2) concat demuxer 拼接图像轨(work 相对路径)
    await writeFile(join(work, "concat.txt"), clipNames.map((n) => `file '${n}'`).join("\n"), "utf-8");
    if ((await runFf(["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", "video.mp4"], work, log)) !== 0)
      return { ok: false, error: "图像轨 concat 失败" };

    // 3) 音频:voice 轨按序 concat;bgm 若有则低音量 amix
    const voiceClips = timeline.tracks.filter((t) => t.type === "audio" && (t as { role?: string }).role !== "bgm") as Array<Extract<Timeline["tracks"][number], { type: "audio" }>>;
    const bgmClips = timeline.tracks.filter((t) => t.type === "audio" && (t as { role?: string }).role === "bgm") as Array<Extract<Timeline["tracks"][number], { type: "audio" }>>;
    let haveAudio = false;
    if (voiceClips.length > 0) {
      // 拷贝 voice 文件进 work,concat filter 按序拼接
      const vArgs: string[] = ["-y", "-loglevel", "error"];
      const present: number[] = [];
      voiceClips.forEach((v, i) => {
        const abs = join(taskDir, v.src);
        if (existsSync(abs)) { vArgs.push("-i", abs); present.push(i); }
      });
      if (present.length > 0) {
        const inputs = present.map((_, idx) => `[${idx}:a]`).join("");
        vArgs.push("-filter_complex", `${inputs}concat=n=${present.length}:v=0:a=1[a]`, "-map", "[a]", "-c:a", "aac", "-b:a", "128k", "voice.m4a");
        if ((await runFf(vArgs, work, log)) === 0) haveAudio = true;
        else log("voice concat 失败,成片将无配音");
      }
    }
    // bgm 混音(可选;当前 timelineBuild 未产 bgm,留通路)
    if (haveAudio && bgmClips.length > 0) {
      const bgmAbs = join(taskDir, bgmClips[0].src);
      if (existsSync(bgmAbs)) {
        const vol = bgmClips[0].volume ?? 0.2;
        const code = await runFf(["-y", "-loglevel", "error", "-i", "voice.m4a", "-stream_loop", "-1", "-i", bgmAbs,
          "-filter_complex", `[1:a]volume=${vol}[b];[0:a][b]amix=inputs=2:duration=first:normalize=0[a]`,
          "-map", "[a]", "-c:a", "aac", "audio.m4a"], work, log);
        if (code === 0) { await rm(join(work, "voice.m4a"), { force: true }).catch(() => {}); }
      }
    }
    const audioFile = existsSync(join(work, "audio.m4a")) ? "audio.m4a" : existsSync(join(work, "voice.m4a")) ? "voice.m4a" : null;

    // 4) 生成 ass(字幕 cue + 标题/声明文字叠加)
    const assPath = join(work, "sub.ass");
    await writeFile(assPath, buildAss(timeline, W, H), "utf-8");

    // 5) 烧字幕 + 混音 → 临时输出,再原子 rename 到 outPath
    const tmpOut = join(work, "final_out.mp4");
    const burnArgs: string[] = ["-y", "-loglevel", "error", "-i", "video.mp4"];
    if (audioFile) burnArgs.push("-i", audioFile);
    burnArgs.push("-vf", `subtitles=sub.ass:fontsdir=.`);
    if (audioFile) burnArgs.push("-map", "0:v", "-map", "1:a", "-shortest");
    burnArgs.push("-c:v", "libx264", "-preset", x264preset, "-pix_fmt", "yuv420p");
    if (audioFile) burnArgs.push("-c:a", "aac", "-b:a", "128k");
    burnArgs.push("final_out.mp4");
    if ((await runFf(burnArgs, work, log)) !== 0) return { ok: false, error: "烧字幕/混音失败" };

    // 原子替换 outPath(Windows 占用则退回 copy)
    try {
      if (existsSync(outPath)) await rm(outPath, { force: true });
      await rename(tmpOut, outPath);
    } catch {
      await copyFile(tmpOut, outPath);
    }
    log(`FFmpeg 渲染完成 → ${outRel}`);
    return { ok: true, note: "ffmpeg" };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** 由 timeline 生成 ass:字幕(底部黄字) + 标题(顶部) + 声明(底部小字) */
function buildAss(timeline: Timeline, W: number, H: number): string {
  const sub = timeline.tracks.find((t) => t.type === "subtitle") as
    | Extract<Timeline["tracks"][number], { type: "subtitle" }>
    | undefined;
  const style = sub?.style ?? {};
  const subSize = Math.round((style.fontSize ?? 18) * 3);
  const subColor = assColor(style.color ?? "#FFDE00");
  const marginV = style.marginV ?? 220;

  const styles = [
    `Style: Sub,SimHei,${subSize},${subColor},&H00000000,1,3,2,2,60,60,${marginV}`,
    `Style: Title,SimHei,${Math.round((style.fontSize ?? 18) * 4)},${subColor},&H00000000,1,4,3,8,60,60,120`,
    `Style: Disc,SimHei,${Math.round((style.fontSize ?? 18) * 1.4)},${assColor("#FFFFFF", 0x50)},&H00000000,0,2,1,2,50,50,40`,
  ];

  const events: string[] = [];
  if (sub) {
    for (const cue of sub.cues) {
      const end = Math.max(cue.start + 0.1, cue.end);
      events.push(`Dialogue: 0,${assTime(cue.start)},${assTime(end)},Sub,,0,0,0,,${assText(cue.text)}`);
    }
  }
  for (const t of timeline.tracks) {
    if (t.type === "text") {
      const st = t.role === "title" ? "Title" : t.role === "disclaimer" ? "Disc" : "Sub";
      events.push(`Dialogue: 0,${assTime(t.start)},${assTime(t.start + t.duration)},${st},,0,0,0,,${assText(t.text)}`);
    }
  }

  return (
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\n\n` +
    `[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n` +
    styles.join("\n") + `\n\n` +
    `[Events]\n` +
    `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    events.join("\n") + `\n`
  );
}

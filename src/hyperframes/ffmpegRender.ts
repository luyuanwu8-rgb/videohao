import { join, dirname, resolve, basename, sep } from "node:path";
import { writeFile, mkdir, copyFile, rm, rename, readFile, statfs } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freemem } from "node:os";
import type { Timeline } from "@/lib/timeline";
import { motionPreset, DEFAULT_MOTION } from "@/lib/motions";
import type { RenderInput, RenderResult } from "./render";
import { registerActiveWorkDir, unregisterActiveWorkDir, sweepWorkDirs } from "@/lib/cleanup";
import { loadSubtitleFilters, applySubtitleFilters } from "@/lib/subtitleFilters";
import { validateRenderedVideo } from "./validate";

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

/** 探测图片平均亮度 YAVG(0-255);128px 缩略图秒级;失败返回 -1(不影响渲染) */
function probeYavg(imgAbs: string): Promise<number> {
  return new Promise((res) => {
    const ff = process.env.FFMPEG_PATH || "ffmpeg";
    const child = spawn(ff, ["-hide_banner", "-i", imgAbs, "-vf", "scale=128:-1,signalstats,metadata=print",
      "-frames:v", "1", "-f", "null", "-"], { shell: process.platform === "win32" });
    let err = "";
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", () => res(-1));
    child.on("close", () => { const m = /YAVG=([\d.]+)/.exec(err); res(m ? parseFloat(m[1]) : -1); });
  });
}

function ffconcatLine(absPath: string): string {
  return `file '${absPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

function probeDuration(mediaAbs: string): Promise<number> {
  return new Promise((res) => {
    const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
    const child = spawn(ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      mediaAbs,
    ], { shell: process.platform === "win32" });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.on("error", () => res(Number.NaN));
    child.on("close", () => {
      const n = Number.parseFloat(out.trim());
      res(Number.isFinite(n) ? n : Number.NaN);
    });
  });
}

/** 据亮度算 gamma(ffmpeg eq 里 gamma>1 才提亮,已实测确认):仅暗于 threshold 才提,使均值→target,上限封顶防过提。返回 1=原样不动 */
function brightnessGamma(yavg: number, target: number, threshold: number, maxGamma: number): number {
  if (yavg <= 0 || yavg >= threshold) return 1;            // 探测失败 或 本就够亮 → 不动
  // ffmpeg eq: out=in^(1/gamma),故 gamma>1 提亮(与标准 gamma 相反)。使 (yavg/255)^(1/gamma)=target/255
  const g = Math.log(yavg / 255) / Math.log(target / 255);
  return Math.max(1, Math.min(maxGamma, g));               // 夹到 [1, maxGamma]
}

/** 并发上限跑一批异步任务(探测用),避免同时 spawn 上百个 ffmpeg */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i]); }
  });
  await Promise.all(workers);
  return out;
}

const activeFfmpegRenders = new Set<string>();
const MiB = 1024 * 1024;

function elapsedMs(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes >= 1024 * MiB) return `${(bytes / 1024 / MiB).toFixed(1)}GB`;
  return `${(bytes / MiB).toFixed(0)}MB`;
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function resolveWorkRoot(taskDir: string): string {
  const configured = process.env.VIDEOHAO_RENDER_WORK_ROOT?.trim();
  return resolve(configured || join(taskDir, "renders"));
}

function safeWorkDir(root: string, work: string): boolean {
  const r = resolve(root);
  const w = resolve(work);
  return basename(w).startsWith("ffwork-") && (w === r || w.startsWith(r + sep));
}

async function preflightRenderResources(input: {
  workRoot: string;
  timeline: Timeline;
  log: (m: string) => void;
}): Promise<{ ok: boolean; error?: string }> {
  const { workRoot, timeline, log } = input;
  const freeMem = freemem();
  const warnMemMb = envNumber("FFRENDER_WARN_FREE_MEM_MB", 768);
  if (freeMem < warnMemMb * MiB) {
    log(`资源预警:当前可用内存仅 ${fmtBytes(freeMem)}，建议先关闭大内存程序；本轮仍按串行渲染继续`);
  }

  const free = await freeBytes(workRoot);
  if (free == null) {
    log(`资源预警:无法探测渲染临时目录剩余空间 ${workRoot}，继续但保留严格成片验收`);
    return { ok: true };
  }

  const estimated = Math.max(2 * 1024 * MiB, timeline.duration * 6 * MiB);
  const minFree = Math.max(envNumber("FFRENDER_MIN_FREE_MB", 4096) * MiB, estimated);
  if (free < minFree) {
    return {
      ok: false,
      error: `渲染临时目录空间不足: ${workRoot} 剩余 ${fmtBytes(free)}，建议至少 ${fmtBytes(minFree)}。可设置 VIDEOHAO_RENDER_WORK_ROOT 到健康且空间充足的磁盘。`,
    };
  }
  log(`资源检查:临时目录 ${workRoot} 剩余 ${fmtBytes(free)}，预估本轮需要 ${fmtBytes(estimated)}；可用内存 ${fmtBytes(freeMem)}`);
  return { ok: true };
}

/** 渲染单张图为一段 clip(zoompan+fade+滤镜);缺图用黑场兜底 */
async function renderClip(
  o: { work: string; srcAbs: string; outName: string; frames: number; W: number; H: number; fps: number;
       zoomFrom: number; zoomTo: number; fadeIn: number; colorFilter: string; ss: number; clipPreset: string; clipCrf: string; brightFilter: string },
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
      (o.brightFilter || "") +
      fade + color + `format=yuv420p`;
    args = ["-y", "-loglevel", "error", "-i", o.srcAbs, "-vf", vf, "-frames:v", String(frames),
            "-r", String(o.fps), "-c:v", "libx264", "-preset", o.clipPreset, "-crf", o.clipCrf, "-pix_fmt", "yuv420p", o.outName];
  } else {
    // 缺图 → 黑场兜底,渲染不崩
    log(`缺图,用黑场兜底: ${o.srcAbs}`);
    args = ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=${o.W}x${o.H}:r=${o.fps}`,
            "-frames:v", String(frames), "-c:v", "libx264", "-preset", o.clipPreset, "-crf", o.clipCrf, "-pix_fmt", "yuv420p", o.outName];
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

  const lockKey = resolve(taskDir);
  if (activeFfmpegRenders.has(lockKey)) {
    return { ok: false, error: "该任务已有 FFmpeg 渲染进行中，已拒绝并发渲染（防止互删临时文件/覆盖成片）" };
  }
  activeFfmpegRenders.add(lockKey);

  const totalStart = Date.now();
  const { width: W, height: H, fps } = timeline;
  const preset = motionPreset(timeline.motion ?? DEFAULT_MOTION);
  const colorFilter = cssFilterToFfmpeg(preset.filter);
  const ss = Number(process.env.FFRENDER_SUPERSAMPLE ?? "1.5"); // 消抖超采样倍数;实测1.5x抖动指标≤2x且渲染快约39%,如需回退设 FFRENDER_SUPERSAMPLE=2
  const x264preset = process.env.FFRENDER_X264_PRESET || "medium"; // 最终(烧字幕)那一遍的编码档——去双重编码后这是唯一一次高质量编码
  // 去双重编码:clip 段只是中间产物(烧字幕时会整片重编一次),故用极速+近无损档——省 clip 编码时间,且不叠加画质损失
  const clipPreset = process.env.FFRENDER_CLIP_PRESET || "ultrafast";
  const clipCrf = process.env.FFRENDER_CLIP_CRF || "15";
  // 自适应提亮:并行探测每段源图亮度,只对偏暗图(YAVG<阈值)按需提 gamma,好图一律不动、不过曝。可一键关。
  const autoBright = (process.env.FFRENDER_AUTO_BRIGHTNESS ?? "1") !== "0";
  const brightTarget = Number(process.env.FFRENDER_BRIGHTNESS_TARGET ?? "105");
  const brightThreshold = Number(process.env.FFRENDER_BRIGHTNESS_THRESHOLD ?? "100");
  const brightMaxGamma = Number(process.env.FFRENDER_BRIGHTNESS_MAX_GAMMA ?? "1.8");

  const workRoot = resolveWorkRoot(taskDir);
  try {
    await mkdir(workRoot, { recursive: true });
  } catch (e) {
    activeFfmpegRenders.delete(lockKey);
    return { ok: false, error: `创建渲染临时根目录失败: ${workRoot}: ${e instanceof Error ? e.message : e}` };
  }
  const resourceCheck = await preflightRenderResources({ workRoot, timeline, log });
  if (!resourceCheck.ok) {
    activeFfmpegRenders.delete(lockKey);
    return { ok: false, error: resourceCheck.error };
  }

  const work = join(workRoot, `ffwork-${Date.now()}-${process.pid}`);
  if (!safeWorkDir(workRoot, work)) {
    activeFfmpegRenders.delete(lockKey);
    return { ok: false, error: `渲染临时目录安全校验失败: ${work}` };
  }
  try {
    await mkdir(work, { recursive: true });
  } catch (e) {
    activeFfmpegRenders.delete(lockKey);
    return { ok: false, error: `创建渲染临时目录失败: ${work}: ${e instanceof Error ? e.message : e}` };
  }
  registerActiveWorkDir(work);           // 登记为活动目录 → 清理扫描一律跳过它
  void sweepWorkDirs().catch(() => {});  // 顺手清历史孤儿废料(非阻塞;已登记的本次目录不受影响)
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

    // 自适应提亮:并行探测每段源图亮度,只对偏暗图算 gamma(好图不动)。探测失败/关闭则不提。
    const brightBySrc = new Map<string, string>();
    if (autoBright) {
      const phaseStart = Date.now();
      const uniqSrcs = Array.from(new Set(imgClips.map((c) => c.src)));
      const yavgs = await mapLimit(uniqSrcs, 8, (s) => {
        const abs = join(taskDir, s);
        return existsSync(abs) ? probeYavg(abs) : Promise.resolve(-1);
      });
      let lifted = 0;
      uniqSrcs.forEach((s, i) => {
        const g = brightnessGamma(yavgs[i], brightTarget, brightThreshold, brightMaxGamma);
        if (g > 1) { brightBySrc.set(s, `eq=gamma=${g.toFixed(3)},`); lifted++; }
      });
      log(`自适应提亮:探测 ${uniqSrcs.length} 图,提亮 ${lifted} 张暗图(target=${brightTarget}/阈值=${brightThreshold})，耗时 ${elapsedMs(phaseStart)}`);
    }

    const clipNames: string[] = [];
    const clipsStart = Date.now();
    for (let i = 0; i < imgClips.length; i++) {
      const c = imgClips[i];
      const startFrame = Math.round(c.start * fps);
      const endFrame = Math.round((c.start + c.duration) * fps);
      const frames = Math.max(1, endFrame - startFrame);
      const outName = `clip_${String(i).padStart(4, "0")}.mp4`;
      const clipStart = Date.now();
      const ok = await renderClip(
        { work, srcAbs: join(taskDir, c.src), outName, frames, W, H, fps,
          zoomFrom: c.zoom?.from ?? preset.zoom.from, zoomTo: c.zoom?.to ?? preset.zoom.to,
          fadeIn: preset.fadeIn, colorFilter, ss, clipPreset, clipCrf, brightFilter: brightBySrc.get(c.src) ?? "" },
        log
      );
      if (!ok) return { ok: false, error: `第 ${i} 段图渲染失败` };
      clipNames.push(outName);
      log(`clip ${i + 1}/${imgClips.length}: ${frames} 帧, ${elapsedMs(clipStart)}`);
    }
    log(`clip 阶段完成: ${imgClips.length} 段, 耗时 ${elapsedMs(clipsStart)}`);

    // 2) concat demuxer 拼接图像轨(work 相对路径)
    let phaseStart = Date.now();
    await writeFile(join(work, "concat.txt"), clipNames.map((n) => `file '${n}'`).join("\n"), "utf-8");
    if ((await runFf(["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", "video.mp4"], work, log)) !== 0)
      return { ok: false, error: "图像轨 concat 失败" };
    log(`图像轨 concat 完成: ${elapsedMs(phaseStart)}`);

    // 3) 音频:voice 轨按序 concat;bgm 若有则低音量 amix
    phaseStart = Date.now();
    const voiceClips = timeline.tracks.filter((t) => t.type === "audio" && (t as { role?: string }).role !== "bgm") as Array<Extract<Timeline["tracks"][number], { type: "audio" }>>;
    const bgmClips = timeline.tracks.filter((t) => t.type === "audio" && (t as { role?: string }).role === "bgm") as Array<Extract<Timeline["tracks"][number], { type: "audio" }>>;
    let haveAudio = false;
    if (voiceClips.length > 0) {
      // 用 concat demuxer 顺序拼接 voice 文件，再统一转 AAC。
      // 比 “几十个 -i + filter_complex concat” 更稳：避开 Windows shell 参数拼接、超长 filtergraph 和 MP3 时间戳边界问题。
      const present = [...voiceClips]
        .sort((a, b) => a.start - b.start)
        .map((v) => join(taskDir, v.src))
        .filter((abs) => existsSync(abs));
      if (present.length > 0) {
        await writeFile(join(work, "voice_concat.txt"), present.map(ffconcatLine).join("\n"), "utf-8");
        const code = await runFf(
          ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "voice_concat.txt", "-vn", "-c:a", "aac", "-b:a", "128k", "voice.m4a"],
          work,
          log
        );
        if (code === 0) haveAudio = true;
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
    log(`音频拼接/混音完成: ${elapsedMs(phaseStart)}${audioFile ? "" : "(无音频)"}`);
    if (audioFile) {
      const audioDuration = await probeDuration(join(work, audioFile));
      if (Number.isFinite(audioDuration)) {
        const tolerance = Math.max(2, timeline.duration * 0.02);
        log(`音频时长检查: ${audioDuration.toFixed(2)}s / timeline ${timeline.duration.toFixed(2)}s`);
        if (audioDuration + tolerance < timeline.duration) {
          return {
            ok: false,
            error: `音频拼接时长异常: ${audioDuration.toFixed(2)}s，预期 ${timeline.duration.toFixed(2)}s`,
          };
        }
      } else {
        log("音频时长检查: ffprobe 读取失败,继续交由成片验收兜底");
      }
    }

    // 4) 生成 ass(字幕 cue + 标题/声明文字叠加)。渲染时再应用一次违规词库 → 加词后只重渲即生效。
    phaseStart = Date.now();
    const assPath = join(work, "sub.ass");
    const subFilters = await loadSubtitleFilters();
    if (subFilters.length) log(`字幕渲染:应用 ${subFilters.length} 条违规词库替换`);
    await writeFile(assPath, buildAss(timeline, W, H, subFilters), "utf-8");
    log(`字幕 ASS 生成完成: ${elapsedMs(phaseStart)}`);

    // 5) 烧字幕 + 混音 → 临时输出,再原子 rename 到 outPath
    phaseStart = Date.now();
    const tmpOut = join(work, "final_out.mp4");
    const burnArgs: string[] = ["-y", "-loglevel", "error", "-i", "video.mp4"];
    if (audioFile) burnArgs.push("-i", audioFile);
    burnArgs.push("-vf", `subtitles=sub.ass:fontsdir=.`);
    if (audioFile) burnArgs.push("-map", "0:v", "-map", "1:a", "-shortest");
    burnArgs.push("-c:v", "libx264", "-preset", x264preset, "-crf", process.env.FFRENDER_FINAL_CRF || "20", "-pix_fmt", "yuv420p");
    if (audioFile) burnArgs.push("-c:a", "aac", "-b:a", "128k");
    burnArgs.push("final_out.mp4");
    if ((await runFf(burnArgs, work, log)) !== 0) return { ok: false, error: "烧字幕/混音失败" };
    log(`烧字幕/最终编码完成: ${elapsedMs(phaseStart)} (preset=${x264preset}, crf=${process.env.FFRENDER_FINAL_CRF || "20"})`);

    phaseStart = Date.now();
    const validation = await validateRenderedVideo({ filePath: tmpOut, timeline, log });
    if (!validation.ok) return { ok: false, error: validation.error ?? "成片验收失败" };
    log(`成片验收阶段完成: ${elapsedMs(phaseStart)} (mode=${process.env.RENDER_VALIDATE || "strict"})`);

    // 原子替换 outPath(Windows 占用则退回 copy)
    phaseStart = Date.now();
    try {
      if (existsSync(outPath)) await rm(outPath, { force: true });
      await rename(tmpOut, outPath);
    } catch {
      await copyFile(tmpOut, outPath);
    }
    log(`成片写入完成: ${elapsedMs(phaseStart)}`);
    log(`FFmpeg 渲染完成 → ${outRel}，总耗时 ${elapsedMs(totalStart)}`);
    return { ok: true, note: "ffmpeg" };
  } finally {
    if (safeWorkDir(workRoot, work)) {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    } else {
      log(`跳过临时目录清理:安全校验失败 ${work}`);
    }
    unregisterActiveWorkDir(work); // 先删本次目录(期间仍受保护)再摘登记
    activeFfmpegRenders.delete(lockKey);
  }
}

/** 由 timeline 生成 ass:字幕(底部黄字) + 标题(顶部) + 声明(底部小字)。
 *  subFilters:字幕违规词库,渲染时对字幕 cue 再应用一次——这样加词后只重渲即可过滤,无需重跑字幕步骤。 */
function buildAss(timeline: Timeline, W: number, H: number, subFilters: import("@/lib/subtitleFilters").FilterRule[] = []): string {
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
      const txt = subFilters.length ? applySubtitleFilters(cue.text, subFilters) : cue.text;
      events.push(`Dialogue: 0,${assTime(cue.start)},${assTime(end)},Sub,,0,0,0,,${assText(txt)}`);
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

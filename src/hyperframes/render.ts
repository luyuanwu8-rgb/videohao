import { join, dirname, resolve } from "node:path";
import { writeFile, mkdir, copyFile, readdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Timeline } from "@/lib/timeline";
import { buildCompositionHtml } from "./template";

/**
 * 渲染后端抽象。
 *
 * 上层只给 timeline.json + 任务目录，本模块负责把它渲成 mp4。
 * 默认后端是 HyperFrames CLI；mock 模式写占位文件让链路跑通。
 *
 * 将来换 Remotion/FFmpeg：只改这里的 real 分支，timeline 协议不变。
 */

export interface RenderInput {
  timeline: Timeline;
  taskDir: string;
  outRel: string; // 相对任务目录，如 final.mp4
  mode: "mock" | "real";
  log: (msg: string) => void;
}

export interface RenderResult {
  ok: boolean;
  error?: string;
  note?: string;
}

const HF_VERSION = process.env.HYPERFRAMES_VERSION ?? "0.7.5";

// 任务级渲染锁：同一 taskDir 同时只允许一个渲染实例，杜绝并发互删 work 目录
// （历史事故：两个实例并发，后启动者 cleanRendersDir 删掉前者正在用的帧 → capture_disk ENOENT）
const activeRenders = new Set<string>();

/** 项目模板目录（打包的字体等静态资源所在） */
function templateDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "template");
}

export async function renderTimeline(input: RenderInput): Promise<RenderResult> {
  const { timeline, taskDir, outRel, mode, log } = input;
  const outPath = join(taskDir, outRel);

  if (mode === "mock") {
    // 占位：写一个标记文件，证明链路走到成片这步
    const placeholder = Buffer.from(
      `MOCK MP4\nduration=${timeline.duration}s\ntracks=${timeline.tracks.length}\n`,
      "utf-8"
    );
    await writeFile(outPath, placeholder);
    log(`mock 渲染：写占位 final.mp4 (${timeline.duration.toFixed(1)}s)`);
    return { ok: true, note: "mock placeholder" };
  }

  // === real：HyperFrames CLI ===
  // 任务级锁：同一 taskDir 已有渲染在跑则拒绝，防止并发实例互删 work 目录
  const lockKey = resolve(taskDir);
  if (activeRenders.has(lockKey)) {
    return { ok: false, error: `该任务已有渲染进行中，已拒绝并发渲染（防互删帧）` };
  }
  activeRenders.add(lockKey);
  try {
    return await renderReal(input);
  } finally {
    activeRenders.delete(lockKey);
  }
}

/** 真实渲染主体（已被任务锁包裹，保证同 taskDir 串行） */
async function renderReal(input: RenderInput): Promise<RenderResult> {
  const { timeline, taskDir, outRel, mode, log } = input;
  const outPath = join(taskDir, outRel);
  // 渲染工作区就用 taskDir 本身：index.html 与 images/、voice/ 同级，
  // composition 里的相对路径(images/1.png / voice/1.wav)直接命中。
  const html = buildCompositionHtml(timeline);
  await writeFile(join(taskDir, "index.html"), html, "utf-8");
  await writeFile(
    join(taskDir, "meta.json"),
    JSON.stringify({ id: "videohao", name: "videohao" }, null, 2),
    "utf-8"
  );

  // 打包字体复制进工作区（中文字幕必须，不能依赖系统字体）
  const fontSrc = join(templateDir(), "assets", "fonts", "simhei.ttf");
  const fontDst = join(taskDir, "assets", "fonts", "simhei.ttf");
  await mkdir(dirname(fontDst), { recursive: true });
  if (existsSync(fontSrc)) {
    await copyFile(fontSrc, fontDst);
  } else {
    return { ok: false, error: `打包字体缺失: ${fontSrc}` };
  }

  // --workers：并行多 Chrome 截图，缩短逐帧 capture。每 worker 一个独立无头 Chrome(官方实测各占~256MB，
  //   与你日常开的浏览器是完全独立的进程，不复用不共享——但吃的是同一块物理内存)。
  // 默认固定 4：
  //   * 旧版写死 2 是历史包袱(怕 OOM)，等于亲手把速度按死；
  //   * 但本机内存常被浏览器占到只剩 2~3G，若放 auto，HyperFrames 探测到内存吃紧会自动进
  //     low-memory-mode 锁死 1 worker —— 比 2 还慢；auto 在内存富裕时又可能拉满 12 个 Chrome 撑爆。
  //   * 固定 4 是折中：4×256MB≈1G，在 2~3G 空闲里有余量，拿到 4 倍并行，且不依赖你关浏览器。
  //   内存充裕想更快可设 HYPERFRAMES_WORKERS=auto 或更大数。
  // --no-low-memory-mode：强制禁用"低内存自动降速"，防止被你浏览器的内存占用拖回 1 worker。
  //   (真到极限 OOM 退出码1，再用 HYPERFRAMES_WORKERS 调低即可。)
  // --quality draft：带货视频是静图+字幕+慢推拉，draft 肉眼几乎无差但明显更快(默认 standard)。
  //   要高画质定稿可用 HYPERFRAMES_QUALITY=high 覆盖。
  const rendersDir = join(taskDir, "renders");
  // 渲染前清理 renders 下的"陈旧"work-* 残留(>10分钟,确属上次遗留)，
  // 不碰新近目录——配合任务锁，双保险防误删活动中的帧目录。
  await cleanRendersDir(rendersDir, 10 * 60 * 1000);
  const workers = process.env.HYPERFRAMES_WORKERS || "4";
  const quality = process.env.HYPERFRAMES_QUALITY || "draft";
  const MAX_ATTEMPTS = Number(process.env.RENDER_MAX_ATTEMPTS ?? "3"); // 含首次,共试3次
  log(`渲染参数: workers=${workers} quality=${quality} fps=${timeline.fps} (no-low-memory-mode)`);

  let code = 1;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 每次重试前清掉上一轮残留的 work-*（防半成品帧污染下一轮）
    if (attempt > 1) {
      await cleanRendersDir(rendersDir, 0); // 重试时清全部 work（本任务已加锁，无并发风险）
      log(`渲染重试 第 ${attempt}/${MAX_ATTEMPTS} 次…`);
    }
    code = await runHyperframes(
      [
        "--yes",
        `hyperframes@${HF_VERSION}`,
        "render",
        ".",
        "--fps",
        String(timeline.fps),
        "--workers",
        workers,
        "--quality",
        quality,
        "--no-low-memory-mode",
        "--quiet",
      ],
      taskDir,
      log
    );
    if (code === 0) break; // 成功就退出重试
    log(`渲染退出码 ${code}（第 ${attempt} 次）`);
  }
  if (code !== 0) {
    return { ok: false, error: `hyperframes render 退出码 ${code}（已重试 ${MAX_ATTEMPTS} 次仍失败）` };
  }

  // 渲染产物默认落在 renders/<name>.mp4，取最新的一个移成 final.mp4
  const produced = await latestMp4(rendersDir);
  if (!produced) {
    return { ok: false, error: "渲染完成但未找到产物 mp4" };
  }
  // Windows 上 final.mp4 可能被浏览器 <video> 占用句柄，直接 rename 会 EPERM。
  // 先尝试删旧文件再 rename；失败则退回 copyFile（copy 不要求独占重命名权限）。
  try {
    if (existsSync(outPath)) await rm(outPath, { force: true });
    await rename(produced, outPath);
  } catch {
    await copyFile(produced, outPath);
    await rm(produced, { force: true }).catch(() => {});
  }
  log(`HyperFrames 渲染完成 → ${outRel}`);
  return { ok: true, note: "hyperframes" };
}

function runHyperframes(
  args: string[],
  cwd: string,
  log: (m: string) => void
): Promise<number> {
  return new Promise((resolvePromise) => {
    const cacheRoot = process.env.VIDEOHAO_NPM_CACHE;
    const tmpRoot = process.env.VIDEOHAO_TMP;
    const env = { ...process.env };
    if (cacheRoot) env.npm_config_cache = cacheRoot;
    if (tmpRoot) {
      env.TEMP = tmpRoot;
      env.TMP = tmpRoot;
    }
    // Windows 上 npx 需要 npx.cmd / shell
    const child = spawn("npx", args, {
      cwd,
      env,
      shell: process.platform === "win32",
    });
    child.stdout.on("data", (d) => {
      const s = String(d).trim();
      if (s) log(s.slice(0, 200));
    });
    child.stderr.on("data", (d) => {
      const s = String(d).trim();
      if (s && !/TAR_ENTRY|base256|zlib|corrupted/.test(s)) log(s.slice(0, 200));
    });
    child.on("close", (code) => resolvePromise(code ?? 1));
    child.on("error", (err) => {
      log(`spawn 失败: ${err.message}`);
      resolvePromise(1);
    });
  });
}

async function latestMp4(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".mp4"));
  if (files.length === 0) return null;
  // 按修改时间取最新：renders/ 可能同时有已重命名的成品(cinematic.mp4)和本次新产的
  // 时间戳文件，字典序会取错(任务id前缀"5" < "c")，必须用 mtime 才可靠。
  const { stat } = await import("node:fs/promises");
  let newest = "";
  let newestMs = -1;
  for (const f of files) {
    const p = resolve(dir, f);
    const ms = (await stat(p).catch(() => null))?.mtimeMs ?? -1;
    if (ms > newestMs) {
      newestMs = ms;
      newest = p;
    }
  }
  return newest || null;
}

/** 清理 renders 目录下的 work-* 临时目录（防句柄堆积/磁盘膨胀）。
 * @param minAgeMs 仅删修改时间早于该阈值的目录(毫秒)。0=全删。
 *   默认带阈值是为了不误删"正在写入"的活动目录(配合任务锁双保险)。
 * 注意：不删 .mp4 成品——多动效批量时各条成品都留在 renders/ 供画廊展示。 */
async function cleanRendersDir(dir: string, minAgeMs = 0): Promise<void> {
  if (!existsSync(dir)) return;
  const { stat } = await import("node:fs/promises");
  const now = Date.now();
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.startsWith("work-")) continue;
    const p = resolve(dir, name);
    if (minAgeMs > 0) {
      const mtime = (await stat(p).catch(() => null))?.mtimeMs ?? now;
      if (now - mtime < minAgeMs) continue; // 太新,可能正在写,跳过
    }
    await rm(p, { recursive: true, force: true }).catch(() => {});
  }
}


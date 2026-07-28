import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  directorSchema,
  imagesSchema,
  rewriteSchema,
  storyboardSchema,
  type Director,
  type ImageItem,
  type Rewrite,
  type Storyboard,
} from "@/lib/domain";

export const bookCoverConfigSchema = z.object({
  version: z.literal(1),
  sourceBook: z.string().default(""),
  originalName: z.string(),
  coverPath: z.string(),
  sha256: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  updatedAt: z.number().int(),
});
export type BookCoverConfig = z.infer<typeof bookCoverConfigSchema>;

export const bookShowcaseConfigSchema = z.object({
  version: z.literal(1),
  sourceBook: z.string().default(""),
  autoCandidateSceneId: z.number().int().positive().nullable().default(null),
  selectedSceneId: z.number().int().positive().nullable().default(null),
  selectedSceneText: z.string().default(""),
  candidateReason: z.string().default(""),
  selectionMode: z.enum(["auto", "manual", "ending-only"]).default("auto"),
  confirmed: z.boolean().default(false),
  showAtEnd: z.boolean().default(true),
  updatedAt: z.number().int(),
});
export type BookShowcaseConfig = z.infer<typeof bookShowcaseConfigSchema>;

type Candidate = { sceneId: number; score: number; reason: string };

function compact(text: string): string {
  return text
    .replace(/[《》〈〉「」『』“”"'`·\s，。！？；：、,.!?;:()[\]{}【】]/g, "")
    .toLowerCase();
}

function hasPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * 识别“推荐这本书”的表达意图，而非依赖某一句固定文案。
 * 结果只是候选，最终位置由分镜页面人工确认。
 */
export function detectBookRecommendation(
  board: Storyboard,
  sourceBook: string
): Candidate | null {
  const title = compact(sourceBook);
  const bookRefs = [
    /这本书|本书|该书|这套书|这部书|这册书|这套读物|这本读物|书里|书中/,
  ];
  const recommendation = [
    /推荐|建议|值得|不妨|适合|最好|应该|有兴趣|感兴趣|想了解|需要的朋友/,
  ];
  const acquire = [
    /备(?:上)?(?:一|几)?本|买(?:上)?(?:一|几)?本|入手|收藏|带回家|留在家里|放在(?:家里|床头|茶几|书架)|摆在/,
  ];
  const gift = [
    /送给|送父母|送孩子|给家里人|给老人|给.{0,10}(?:看看|读读|翻翻|备一本|买一本)|全家.{0,8}(?:读|看)/,
  ];
  const readingAction = [
    /找来(?:读|看|翻)|翻一翻|翻翻|读一读|读读|看一看|看看|随手翻|闲下来翻|从这本书开始/,
  ];
  const audience = [/大家|朋友|你|家里|孩子|父母|老人|长辈|全家/];
  const benefit = [/帮助|能让|可以让|学到|明白|懂得|了解|常识|道理|家教|文化/];
  const narrativeOnly = [/我自己|有一回|看完什么也没说|翻到.{0,12}一页|搁在他跟前/];

  let best: Candidate | null = null;
  for (let i = 0; i < board.scenes.length; i++) {
    const scene = board.scenes[i];
    const text = scene.text;
    const nearby = [
      board.scenes[i - 1]?.text ?? "",
      text,
      board.scenes[i + 1]?.text ?? "",
    ].join("");
    const exactHere = title.length >= 2 && compact(text).includes(title);
    const exactNearby = title.length >= 2 && compact(nearby).includes(title);
    const refHere = exactHere || hasPattern(text, bookRefs);
    const refNearby = refHere || exactNearby || hasPattern(nearby, bookRefs);

    const hasRecommend = hasPattern(text, recommendation);
    const hasAcquire = hasPattern(text, acquire);
    const hasGift = hasPattern(text, gift);
    const hasReading = hasPattern(text, readingAction);
    const hasAction = hasRecommend || hasAcquire || hasGift || hasReading;
    if (!refNearby || !hasAction) continue;

    let score = refHere ? 3 : 1;
    if (exactHere) score += 1;
    if (hasRecommend) score += 3;
    if (hasAcquire) score += 4;
    if (hasGift) score += 4;
    if (hasReading) score += 2;
    if (hasPattern(text, audience)) score += 1;
    if (hasPattern(text, benefit)) score += 1;
    if (hasPattern(text, narrativeOnly) && !hasRecommend && !hasAcquire && !hasGift) score -= 2;
    if (score < 5) continue;

    const intents = [
      hasRecommend && "推荐",
      hasAcquire && "备书/购买",
      hasGift && "赠送/给家人阅读",
      hasReading && "阅读行动",
    ].filter(Boolean);
    const candidate = {
      sceneId: scene.id,
      score,
      reason: `检测到书籍语境及${intents.join("、")}意图`,
    };
    if (!best || candidate.score > best.score || (candidate.score === best.score && i > board.scenes.findIndex((s) => s.id === best!.sceneId))) {
      best = candidate;
    }
  }
  return best;
}

async function readJson<S extends z.ZodTypeAny>(
  path: string,
  schema: S
): Promise<z.output<S> | null> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf-8"))) as z.output<S>;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf-8");
  await rm(path, { force: true }).catch(() => {});
  await rename(temp, path);
}

export async function loadBookCoverConfig(taskDir: string): Promise<BookCoverConfig | null> {
  return readJson(join(taskDir, "book-cover.json"), bookCoverConfigSchema);
}

export async function saveBookCoverConfig(
  taskDir: string,
  value: BookCoverConfig
): Promise<void> {
  await writeJsonAtomic(join(taskDir, "book-cover.json"), bookCoverConfigSchema.parse(value));
}

export async function loadBookShowcaseConfig(taskDir: string): Promise<BookShowcaseConfig | null> {
  return readJson(join(taskDir, "book-showcase.json"), bookShowcaseConfigSchema);
}

export async function saveBookShowcaseConfig(
  taskDir: string,
  value: BookShowcaseConfig
): Promise<void> {
  await writeJsonAtomic(join(taskDir, "book-showcase.json"), bookShowcaseConfigSchema.parse(value));
}

export async function buildBookShowcaseConfig(
  rewrite: Rewrite,
  board: Storyboard,
  previous?: BookShowcaseConfig | null
): Promise<BookShowcaseConfig> {
  const candidate = detectBookRecommendation(board, rewrite.sourceBook);
  const now = Math.floor(Date.now() / 1000);

  if (previous?.confirmed && previous.selectionMode === "ending-only") {
    return {
      ...previous,
      sourceBook: rewrite.sourceBook,
      autoCandidateSceneId: candidate?.sceneId ?? null,
      candidateReason: candidate?.reason ?? "未识别到明确推荐语义",
      updatedAt: now,
    };
  }

  if (previous?.confirmed && previous.selectedSceneId) {
    const current = board.scenes.find((scene) => scene.id === previous.selectedSceneId);
    if (current && compact(current.text) === compact(previous.selectedSceneText)) {
      return {
        ...previous,
        sourceBook: rewrite.sourceBook,
        autoCandidateSceneId: candidate?.sceneId ?? null,
        candidateReason: candidate?.reason ?? "未识别到明确推荐语义",
        updatedAt: now,
      };
    }
  }

  const selected = candidate?.sceneId ?? null;
  return {
    version: 1,
    sourceBook: rewrite.sourceBook,
    autoCandidateSceneId: selected,
    selectedSceneId: selected,
    selectedSceneText: board.scenes.find((scene) => scene.id === selected)?.text ?? "",
    candidateReason: candidate?.reason ?? "未识别到明确推荐语义，请手动选择或仅保留结尾展示",
    selectionMode: "auto",
    confirmed: false,
    showAtEnd: true,
    updatedAt: now,
  };
}

/** 旧任务首次打开时也能补齐推荐候选配置。 */
export async function ensureBookShowcaseConfig(taskDir: string): Promise<BookShowcaseConfig | null> {
  const rewrite = await readJson(join(taskDir, "rewrite.json"), rewriteSchema);
  const board = await readJson(join(taskDir, "storyboard.json"), storyboardSchema);
  if (!rewrite || !board) return null;
  const previous = await loadBookShowcaseConfig(taskDir);
  if (previous) return previous;
  const config = await buildBookShowcaseConfig(rewrite, board);
  await saveBookShowcaseConfig(taskDir, config);
  return config;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let error = "";
    child.stderr.on("data", (data) => {
      error += String(data);
      if (error.length > 6000) error = error.slice(-6000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} 退出码 ${code}: ${error.slice(-500)}`));
    });
  });
}

export async function normalizeBookCover(
  inputPath: string,
  outputPath: string
): Promise<{ width: number; height: number; sha256: string }> {
  await mkdir(dirname(outputPath), { recursive: true });
  const temp = `${outputPath}.tmp-${process.pid}-${Date.now()}.png`;
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  await run(ffmpeg, [
    "-y",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    temp,
  ]);
  if (!existsSync(temp) || statSync(temp).size < 1024) {
    throw new Error("上传图片解码后没有得到有效封面");
  }

  const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  let probe = "";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffprobe,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", temp],
      { shell: process.platform === "win32", windowsHide: true }
    );
    child.stdout.on("data", (data) => (probe += String(data)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("封面尺寸探测失败"))));
  });
  const [width, height] = probe.trim().split("x").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 200) {
    await rm(temp, { force: true }).catch(() => {});
    throw new Error("封面分辨率过低，请上传宽高至少 200 像素的图片");
  }

  const normalized = await readFile(temp);
  const sha256 = createHash("sha256").update(normalized).digest("hex");
  await rm(outputPath, { force: true }).catch(() => {});
  await rename(temp, outputPath);
  return { width, height, sha256 };
}

function restoreItem(item: ImageItem): ImageItem {
  const base = item.baseImagePath ?? item.imagePath;
  const restored: ImageItem = {
    ...item,
    imagePath: base,
  };
  delete restored.baseImagePath;
  delete restored.bookShowcase;
  return restored;
}

export function restoreBookShowcases(items: ImageItem[]): ImageItem[] {
  return items.map(restoreItem);
}

async function composeProductShot(
  basePath: string,
  coverPath: string,
  outputPath: string
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const temp = `${outputPath}.tmp-${process.pid}-${Date.now()}.png`;
  const filter =
    "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920," +
    "gblur=sigma=20,eq=brightness=-0.10:saturation=0.72[bg];" +
    "[bg]drawbox=x=95:y=210:w=890:h=1130:color=0x1d130d@0.34:t=fill," +
    "drawbox=x=110:y=195:w=860:h=1130:color=0xf4ead8@0.96:t=fill[card];" +
    "[1:v]scale=800:1040:force_original_aspect_ratio=decrease:flags=lanczos[cover];" +
    "[card][cover]overlay=(W-w)/2:195+(1130-h)/2:format=auto," +
    "drawbox=x=0:y=1480:w=1080:h=440:color=black@0.10:t=fill[out]";
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  await run(ffmpeg, [
    "-y",
    "-loglevel",
    "error",
    "-i",
    basePath,
    "-i",
    coverPath,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-frames:v",
    "1",
    temp,
  ]);
  if (!existsSync(temp) || statSync(temp).size < 8 * 1024) {
    throw new Error("真实封面合成结果无效");
  }
  await rm(outputPath, { force: true }).catch(() => {});
  await rename(temp, outputPath);
}

export type BookApplyResult = {
  items: ImageItem[];
  appliedBeatIds: number[];
  errors: string[];
};

/** 只做本地 FFmpeg 合成；这里没有任何生图 provider 调用。 */
export async function applyBookShowcases(
  taskDir: string,
  inputItems: ImageItem[],
  planInput?: Director
): Promise<BookApplyResult> {
  const items = restoreBookShowcases(inputItems);
  const cover = await loadBookCoverConfig(taskDir);
  const showcase = await loadBookShowcaseConfig(taskDir);
  const coverAbs = cover ? join(taskDir, cover.coverPath) : "";
  if (!cover || !showcase || !existsSync(coverAbs)) {
    return { items, appliedBeatIds: [], errors: [] };
  }

  const plan =
    planInput ??
    directorSchema.parse(JSON.parse(await readFile(join(taskDir, "director.json"), "utf-8")));
  const targets = new Map<number, "recommendation" | "ending" | "recommendation-ending">();
  if (showcase.confirmed && showcase.selectedSceneId) {
    const beat = plan.beats.find((candidate) =>
      candidate.sceneIds.includes(showcase.selectedSceneId!)
    );
    if (beat) targets.set(beat.id, "recommendation");
  }
  if (showcase.showAtEnd && plan.beats.length) {
    const endBeat = plan.beats[plan.beats.length - 1];
    targets.set(
      endBeat.id,
      targets.get(endBeat.id) === "recommendation" ? "recommendation-ending" : "ending"
    );
  }

  await rm(join(taskDir, "images", "book"), { recursive: true, force: true }).catch(() => {});
  const output: ImageItem[] = [];
  const appliedBeatIds: number[] = [];
  const errors: string[] = [];
  for (const item of items) {
    const kind = targets.get(item.beatId);
    if (!kind) {
      output.push(item);
      continue;
    }
    const baseRel = item.imagePath;
    const baseAbs = join(taskDir, baseRel);
    if (!existsSync(baseAbs)) {
      errors.push(`第 ${item.beatId} 拍原场景图缺失`);
      output.push(item);
      continue;
    }
    const resultRel = `images/book/${item.beatId}.png`;
    try {
      await composeProductShot(baseAbs, coverAbs, join(taskDir, resultRel));
      const triggerText =
        kind === "ending"
          ? "视频结尾"
          : showcase.selectedSceneText || "已确认的书籍推荐段";
      output.push({
        ...item,
        baseImagePath: baseRel,
        imagePath: resultRel,
        bookShowcase: {
          kind,
          triggerText,
          triggerSceneId:
            kind === "ending" ? undefined : showcase.selectedSceneId ?? undefined,
        },
      });
      appliedBeatIds.push(item.beatId);
    } catch (error) {
      errors.push(
        `第 ${item.beatId} 拍合成失败: ${error instanceof Error ? error.message : String(error)}`
      );
      output.push(item);
    }
  }
  return {
    items: imagesSchema.parse({ items: output }).items,
    appliedBeatIds,
    errors,
  };
}

export async function readBookAssets(taskDir: string): Promise<{
  cover: BookCoverConfig | null;
  showcase: BookShowcaseConfig | null;
}> {
  return {
    cover: await loadBookCoverConfig(taskDir),
    showcase: await ensureBookShowcaseConfig(taskDir),
  };
}

export async function readImagesIfPresent(taskDir: string): Promise<ImageItem[] | null> {
  return readJson(join(taskDir, "images.json"), imagesSchema).then((value) => value?.items ?? null);
}

export async function readStoryboardIfPresent(taskDir: string): Promise<Storyboard | null> {
  return readJson(join(taskDir, "storyboard.json"), storyboardSchema);
}

export async function readRewriteIfPresent(taskDir: string): Promise<Rewrite | null> {
  return readJson(join(taskDir, "rewrite.json"), rewriteSchema);
}

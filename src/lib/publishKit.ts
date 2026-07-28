import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { chat, parseJsonRobust } from "@/lib/providers/llm";
import { env, type Mode } from "@/lib/providers/base";
import { generateCover } from "@/lib/providers/gptimage";
import { configureLimiter, withLimit } from "@/lib/concurrency";
import { ensureConfigLoaded } from "@/lib/config-cache";

const DATA_ROOT = resolve(process.env.DATA_ROOT ?? "./data");
const PROMPT_VERSION = 1;
const COVER_REL = "publish/cover.png";
const KIT_REL = "publish-kit.json";
const MIN_IMAGE_BYTES = 8 * 1024;

export type PublishKitStatus =
  | "pending"
  | "generating"
  | "completed"
  | "partial"
  | "failed";

const tagSchema = z.object({
  text: z.string(),
  evidence: z.string(),
  kind: z.enum(["book", "theme", "problem", "audience"]).default("theme"),
});

const coverSchema = z.object({
  status: z.enum(["pending", "generating", "completed", "failed"]).default("pending"),
  path: z.string().default(""),
  prompt: z.string().default(""),
  title: z.string().default(""),
  subtitle: z.string().default(""),
  type: z.enum(["A", "B", "C"]).default("C"),
  visual: z.string().default(""),
  error: z.string().default(""),
  generatedAt: z.number().int().default(0),
  cost: z.number().default(0),
});

export const publishKitSchema = z.object({
  version: z.literal(1),
  promptVersion: z.number().int(),
  status: z.enum(["pending", "generating", "completed", "partial", "failed"]),
  sourceHash: z.string(),
  sourceBook: z.string(),
  title: z.string(),
  subtitle: z.string(),
  caption: z.string(),
  tags: z.array(tagSchema),
  comments: z.object({
    conversion: z.string(),
    purchase: z.string(),
  }),
  /** 仅供发布包导出；在第⑨步编辑不会回写 rewrite.json。 */
  fullScript: z.string(),
  cover: coverSchema,
  error: z.string().default(""),
  warnings: z.array(z.string()).default([]),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export type PublishKit = z.infer<typeof publishKitSchema>;
export type PublishTag = z.infer<typeof tagSchema>;
export type PublishKitAction = "all" | "text" | "cover";

const rewriteSchema = z.object({
  title: z.string().default(""),
  sourceBook: z.string().default(""),
  hooks: z.array(z.string()).default([]),
  script: z.string().min(1),
});

const llmResultSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  caption: z.string(),
  tags: z.array(
    z.object({
      tag: z.string(),
      evidence: z.string(),
      kind: z.enum(["theme", "problem", "audience"]).default("theme"),
    })
  ),
  pinnedComment: z.string(),
  coverType: z.enum(["A", "B", "C"]),
  coverVisual: z.string(),
});

const runningJobs = new Map<string, Promise<void>>();

function taskDir(taskId: string): string {
  return join(DATA_ROOT, "tasks", taskId);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

async function readJson<S extends z.ZodTypeAny>(
  path: string,
  schema: S
): Promise<z.output<S> | null> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf-8")));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, JSON.stringify(data, null, 2), "utf-8");
  await rm(path, { force: true }).catch(() => {});
  await rename(temp, path);
}

export async function readPublishKit(taskId: string): Promise<PublishKit | null> {
  return readJson(join(taskDir(taskId), KIT_REL), publishKitSchema);
}

function normalizeBookName(sourceBook: string): string {
  return sourceBook
    .trim()
    .replace(/^[《〈「『【\[]+/, "")
    .replace(/[》〉」』】\]]+$/, "")
    .trim();
}

function normalizeForEvidence(text: string): string {
  return text.replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()《》〈〉【】\[\]-]/g, "");
}

function sanitizeTag(raw: string): string {
  const body = raw
    .replace(/^#+/, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .slice(0, 18);
  return body ? `#${body}` : "";
}

function sourceHash(script: string, sourceBook: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ script, sourceBook, promptVersion: PROMPT_VERSION }))
    .digest("hex");
}

function contentOnlyScript(script: string, sourceBook: string): string {
  const book = normalizeBookName(sourceBook);
  const candidates: number[] = [];
  if (book) {
    const i = script.indexOf(book);
    if (i >= Math.floor(script.length * 0.2)) candidates.push(i);
  }
  for (const marker of [
    "说到这儿，是因为",
    "说到这里，是因为",
    "这本书建议",
    "建议大家给自己备一本",
    "建议大家备一本",
  ]) {
    const i = script.indexOf(marker);
    if (i >= Math.floor(script.length * 0.2)) candidates.push(i);
  }
  if (candidates.length === 0) return script;
  const cut = Math.min(...candidates);
  const prefix = script.slice(0, cut);
  const sentence = Math.max(prefix.lastIndexOf("。"), prefix.lastIndexOf("！"), prefix.lastIndexOf("？"));
  return (sentence > prefix.length * 0.75 ? prefix.slice(0, sentence + 1) : prefix).trim();
}

function purchaseComment(sourceBook: string): string {
  const name = normalizeBookName(sourceBook);
  return [
    "书籍购买方法",
    "① 点我头像进入主页",
    "② 点【商品橱窗】",
    `③ 下拉或用🔍找本书《${name}》`,
  ].join("\n");
}

function makeBookTag(sourceBook: string): PublishTag {
  const name = normalizeBookName(sourceBook);
  return {
    text: sanitizeTag(name),
    evidence: sourceBook,
    kind: "book",
  };
}

function validateTags(
  raw: z.infer<typeof llmResultSchema>["tags"],
  script: string,
  sourceBook: string
): { tags: PublishTag[]; warnings: string[] } {
  const scriptNorm = normalizeForEvidence(script);
  const tags: PublishTag[] = [];
  const seen = new Set<string>();
  const bookTag = makeBookTag(sourceBook);
  if (bookTag.text) {
    tags.push(bookTag);
    seen.add(bookTag.text.toLowerCase());
  }
  for (const item of raw) {
    const text = sanitizeTag(item.tag);
    const evidence = item.evidence.trim();
    const evidenceNorm = normalizeForEvidence(evidence);
    if (!text || !evidenceNorm || !scriptNorm.includes(evidenceNorm)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    if (/^#?(热门|上热门|爆款|必看|涨知识)$/.test(text)) continue;
    seen.add(key);
    tags.push({ text, evidence, kind: item.kind });
    if (tags.length >= 8) break;
  }
  const warnings =
    tags.length >= 7
      ? []
      : [`仅找到 ${tags.length} 个具有原文证据的标签，请人工补充后再发布`];
  return { tags, warnings };
}

function clampTitle(raw: string, fallback: string): string {
  const clean = raw.replace(/[\r\n#《》]/g, "").trim();
  if (clean.length >= 6 && clean.length <= 15) return clean;
  const fb = fallback.replace(/[\r\n#《》]/g, "").trim();
  return (clean || fb || "这件事很多人都忽略了").slice(0, 15);
}

function trimTo(raw: string, max: number): string {
  return raw.trim().slice(0, max);
}

async function generateText(
  script: string,
  sourceBook: string,
  fallbackTitle: string,
  mode: Mode
): Promise<{
  title: string;
  subtitle: string;
  caption: string;
  tags: PublishTag[];
  conversion: string;
  coverType: "A" | "B" | "C";
  coverVisual: string;
  warnings: string[];
  cost: number;
}> {
  if (mode === "mock") {
    const bookTag = makeBookTag(sourceBook);
    return {
      title: clampTitle(fallbackTitle, "值得认真看完的生活常识"),
      subtitle: "藏在日常生活里的老智慧",
      caption: trimTo(script, 140),
      tags: bookTag.text ? [bookTag] : [],
      conversion: `做这期内容，是想把书里真正实用的部分讲给需要的人听。《${normalizeBookName(sourceBook)}》适合放在手边慢慢翻，不用一次读完，遇到生活中的具体问题时再找答案，更容易真正用得上。`,
      coverType: "C",
      coverVisual: "中国普通家庭的真实生活场景，人物自然，暖色电影光影",
      warnings: ["模拟模式未调用文本模型，标签需要人工补充"],
      cost: 0,
    };
  }

  const contentScript = contentOnlyScript(script, sourceBook);
  const system = `你是视频号图书内容的发布策划与电影感封面设计师。只根据用户提供的定稿文案生成发布材料，禁止虚构人物、地点、疾病、功效、情节和书名。

必须输出一个 JSON 对象：
{
  "title": "6-15个汉字，作品标题，同时是封面主标题",
  "subtitle": "封面副标题，从侧面解释正文，不重复主标题",
  "caption": "100-160字视频号发布文案",
  "tags": [{"tag":"标签","evidence":"定稿文案中逐字存在的原句或短语","kind":"theme|problem|audience"}],
  "pinnedComment": "作者置顶评论",
  "coverType": "A|B|C",
  "coverVisual": "封面主体、场景、构图、光影和色彩描述，不写标题文字"
}

标题规则：从正文主体最有传播力的主题提炼；不涉及书名、结尾带货、购买和橱窗；遵守视频号规范，不使用绝对化、恐吓、虚假功效或违规词。
标签规则：给出至少9个候选；每个标签必须与定稿文案直接相关，evidence 必须逐字摘自定稿文案；不得使用热门、上热门、爆款等凑数标签。系统会另行加入书籍名标签，所以 tags 中不要写书名。
置顶评论规则：80-140字，创作者真诚口吻，先理解目标观众的处境，再说明这本书适合谁、具体价值和自然可信的下单理由；不生硬催单，不虚构购买或使用经历。
封面规则：A=具体人物或历史角色；B=地域、地点、宏大事件或文化符号；C=健康、生活常识或现代家庭。画面应适合9:16电影感封面，主体位于中下部，上方3/7为标题留出深色高对比区域。`;
  const user = `【关联书籍】${sourceBook}

【正文主体——标题和封面只能依据这部分，不得涉及书籍和带货】
${contentScript}

【完整定稿文案——发布文案、标签和评论可依据全文】
${script}`;
  const response = await chat(system, user, mode, { json: true, temperature: 0.55 });
  const parsed = llmResultSchema.parse(await parseJsonRobust(response.content, mode));
  const checked = validateTags(parsed.tags, script, sourceBook);
  return {
    title: clampTitle(parsed.title, fallbackTitle),
    subtitle: trimTo(parsed.subtitle, 28),
    caption: trimTo(parsed.caption, 160),
    tags: checked.tags,
    conversion: trimTo(parsed.pinnedComment, 180),
    coverType: parsed.coverType,
    coverVisual: trimTo(parsed.coverVisual, 1200),
    warnings: checked.warnings,
    cost: response.cost,
  };
}

function coverPrompt(
  title: string,
  subtitle: string,
  coverType: "A" | "B" | "C",
  visual: string
): string {
  const typeRule =
    coverType === "A"
      ? "类型A：核心人物采用背影或戏剧性侧影，看不清正脸；服饰与时代准确；近景人物面对宏大深邃场景。"
      : coverType === "B"
        ? "类型B：核心地点、宏大事件或文化符号为绝对主体，使用大远景和强透视纵深，不强行添加人物。"
        : "类型C：现代中国家庭或真实生活场景，一个清晰的生活动作或人物关系作为主体，真实自然，避免夸张病症和医疗恐吓。";
  return `生成一张完整的电影感视频号短视频封面，纵向9:16高清画幅。

【必须逐字准确生成的中文文字】
主标题：“${title}”
副标题：“${subtitle}”
画面中只允许出现以上两组清晰可读的中文标题，不得增加其他标题、标签、水印、字母或标志。主标题每个字必须正确，使用符合正文气质的醒目中文字体；主标题位于整幅图片上方3/7区域，字号大、抓眼、居中；副标题字体较小，紧贴主标题正下方，居中对齐。文字背后必须暗化、留白或增加阴影，保证极高对比度和清晰度。

【画面类型】
${typeRule}

【文案对应的具体视觉】
${visual}

【统一艺术要求】
电影级逆光或侧光，强烈明暗对比，沉稳低饱和色调；水墨黑、深绯红、青铜绿、大漠黄为主，仅在高光和标题使用暖金色点缀。材质真实细腻，有时间痕迹、空间纵深和史诗氛围，避免廉价海报感、普通插画感和过度破败。主体放在中下部，顶部保持足够暗色空间。`;
}

function blankKit(
  script: string,
  sourceBook: string,
  hash: string,
  previous?: PublishKit | null
): PublishKit {
  const t = now();
  return {
    version: 1,
    promptVersion: PROMPT_VERSION,
    status: "generating",
    sourceHash: hash,
    sourceBook,
    title: previous?.title ?? "",
    subtitle: previous?.subtitle ?? "",
    caption: previous?.caption ?? "",
    tags: previous?.tags ?? [],
    comments: previous?.comments ?? {
      conversion: "",
      purchase: purchaseComment(sourceBook),
    },
    fullScript: previous?.sourceHash === hash ? previous.fullScript : script,
    cover: previous?.cover ?? {
      status: "pending",
      path: "",
      prompt: "",
      title: "",
      subtitle: "",
      type: "C",
      visual: "",
      error: "",
      generatedAt: 0,
      cost: 0,
    },
    error: "",
    warnings: previous?.warnings ?? [],
    createdAt: previous?.createdAt ?? t,
    updatedAt: t,
  };
}

async function generateCoverFile(
  dir: string,
  kit: PublishKit,
  coverType: "A" | "B" | "C",
  visual: string,
  mode: Mode
): Promise<PublishKit> {
  const prompt = coverPrompt(kit.title, kit.subtitle, coverType, visual);
  const coverAbs = join(dir, COVER_REL);
  const temp = join(dir, "publish", `cover.tmp-${process.pid}-${Date.now()}.png`);
  const next: PublishKit = {
    ...kit,
    status: "generating",
    cover: {
      ...kit.cover,
      status: "generating",
      prompt,
      title: kit.title,
      subtitle: kit.subtitle,
      type: coverType,
      visual,
      error: "",
    },
    updatedAt: now(),
  };
  await writeJsonAtomic(join(dir, KIT_REL), next);
  await mkdir(dirname(temp), { recursive: true });
  try {
    configureLimiter(
      "gptimage",
      Math.max(1, Number(env("GPTIMAGE_CONCURRENCY", "1")) || 1),
      Math.max(0, Number(env("GPTIMAGE_MIN_GAP_MS", "0")) || 0)
    );
    const result = await withLimit("gptimage", () =>
      generateCover(prompt, temp, "1080x1920", mode)
    );
    if (
      !existsSync(temp) ||
      (mode !== "mock" && statSync(temp).size < MIN_IMAGE_BYTES)
    ) {
      throw new Error("封面接口返回的图片文件无效");
    }
    await mkdir(dirname(coverAbs), { recursive: true });
    await copyFile(temp, coverAbs);
    await rm(temp, { force: true });
    return {
      ...next,
      status: "completed",
      cover: {
        status: "completed",
        path: COVER_REL,
        prompt,
        title: kit.title,
        subtitle: kit.subtitle,
        type: coverType,
        visual,
        error: "",
        generatedAt: now(),
        cost: result.cost,
      },
      updatedAt: now(),
    };
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...next,
      status: "partial",
      cover: {
        ...next.cover,
        status: "failed",
        path: existsSync(coverAbs) ? COVER_REL : "",
        error: message,
      },
      error: `封面生成失败：${message}`,
      updatedAt: now(),
    };
  }
}

async function performGeneration(taskId: string, action: PublishKitAction): Promise<void> {
  await ensureConfigLoaded();
  const dir = taskDir(taskId);
  const rewrite = await readJson(join(dir, "rewrite.json"), rewriteSchema);
  if (!rewrite) throw new Error("缺少最终定稿文案 rewrite.json");
  const sourceBook = rewrite.sourceBook.trim();
  const hash = sourceHash(rewrite.script, sourceBook);
  let current = await readPublishKit(taskId);
  if (!normalizeBookName(sourceBook)) {
    const failed = {
      ...blankKit(rewrite.script, sourceBook, hash, current),
      status: "failed" as const,
      error: "请先在改写稿阶段填写并确认书名",
      updatedAt: now(),
    };
    await writeJsonAtomic(join(dir, KIT_REL), failed);
    return;
  }
  if (
    action === "all" &&
    current?.status === "completed" &&
    current.sourceHash === hash &&
    current.cover.path &&
    existsSync(join(dir, current.cover.path))
  ) {
    return;
  }

  const mode: Mode = process.env.PIPELINE_MODE === "real" ? "real" : "mock";
  let kit = blankKit(rewrite.script, sourceBook, hash, current);
  await writeJsonAtomic(join(dir, KIT_REL), kit);
  let coverType: "A" | "B" | "C" = current?.cover.type ?? "C";
  let coverVisual = current?.cover.visual ?? "";

  if (action !== "cover") {
    try {
      const generated = await generateText(
        rewrite.script,
        sourceBook,
        rewrite.title,
        mode
      );
      coverType = generated.coverType;
      coverVisual = generated.coverVisual;
      const keepExportScript =
        current && current.sourceHash === hash ? current.fullScript : rewrite.script;
      kit = {
        ...kit,
        title: generated.title,
        subtitle: generated.subtitle,
        caption: generated.caption,
        tags: generated.tags,
        comments: {
          conversion: generated.conversion,
          purchase: purchaseComment(sourceBook),
        },
        fullScript: keepExportScript,
        warnings: generated.warnings,
        error: "",
        status: action === "text" ? "completed" : "generating",
        updatedAt: now(),
      };
      await writeJsonAtomic(join(dir, KIT_REL), kit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      kit = {
        ...kit,
        status: "failed",
        error: `发布文字生成失败：${message}`,
        updatedAt: now(),
      };
      await writeJsonAtomic(join(dir, KIT_REL), kit);
      return;
    }
  } else if (!current?.title || !current.subtitle) {
    kit = {
      ...kit,
      status: "failed",
      error: "请先生成发布文字，再生成封面",
      updatedAt: now(),
    };
    await writeJsonAtomic(join(dir, KIT_REL), kit);
    return;
  } else {
    kit = current;
    coverType = current.cover.type;
    coverVisual =
      current.cover.visual || "根据视频正文生成最有代表性的电影感场景";
  }

  if (action === "text") return;
  const finished = await generateCoverFile(dir, kit, coverType, coverVisual, mode);
  await writeJsonAtomic(join(dir, KIT_REL), finished);
}

/**
 * 启动发布资料任务。进程内同一 taskId 只允许一个任务；调用方无需等待生图完成。
 */
export function triggerPublishKit(
  taskId: string,
  action: PublishKitAction = "all"
): { started: boolean; job: Promise<void> } {
  const existing = runningJobs.get(taskId);
  if (existing) return { started: false, job: existing };
  const job = performGeneration(taskId, action)
    .catch(async (error) => {
      const previous = await readPublishKit(taskId);
      if (!previous) return;
      await writeJsonAtomic(join(taskDir(taskId), KIT_REL), {
        ...previous,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: now(),
      }).catch(() => {});
    })
    .finally(() => runningJobs.delete(taskId));
  runningJobs.set(taskId, job);
  return { started: true, job };
}

export async function savePublishKitEdits(
  taskId: string,
  edits: {
    title?: string;
    subtitle?: string;
    caption?: string;
    tags?: string[];
    conversionComment?: string;
    purchaseComment?: string;
    fullScript?: string;
  }
): Promise<PublishKit> {
  const current = await readPublishKit(taskId);
  if (!current) throw new Error("发布资料尚未生成");
  const tags =
    edits.tags === undefined
      ? current.tags
      : (() => {
          const bookTag = makeBookTag(current.sourceBook);
          const edited = edits.tags
            .map(sanitizeTag)
            .filter(Boolean)
            .filter((text, index, all) => all.indexOf(text) === index)
            .map((text) => {
              const old = current.tags.find((item) => item.text === text);
              return old ?? { text, evidence: "人工编辑", kind: "theme" as const };
            });
          return [
            ...(bookTag.text ? [bookTag] : []),
            ...edited.filter((item) => item.text !== bookTag.text),
          ].slice(0, 12);
        })();
  const next = publishKitSchema.parse({
    ...current,
    title: edits.title === undefined ? current.title : edits.title.trim().slice(0, 30),
    subtitle:
      edits.subtitle === undefined ? current.subtitle : edits.subtitle.trim().slice(0, 50),
    caption: edits.caption === undefined ? current.caption : edits.caption.trim(),
    tags,
    comments: {
      conversion:
        edits.conversionComment === undefined
          ? current.comments.conversion
          : edits.conversionComment.trim(),
      purchase:
        edits.purchaseComment === undefined
          ? current.comments.purchase
          : edits.purchaseComment.trim(),
    },
    fullScript:
      edits.fullScript === undefined ? current.fullScript : edits.fullScript.trim(),
    updatedAt: now(),
  });
  await writeJsonAtomic(join(taskDir(taskId), KIT_REL), next);
  return next;
}

export function formatPublishText(kit: PublishKit): string {
  return [
    "【作品标题】",
    kit.title,
    "",
    "【发布文案】",
    kit.caption,
    "",
    "【话题标签】",
    kit.tags.map((item) => item.text).join(" "),
    "",
    "【评论区】",
    "评论1：",
    kit.comments.conversion,
    "",
    "评论2：",
    kit.comments.purchase,
    "",
    "【完整文案】",
    kit.fullScript,
    "",
  ].join("\r\n");
}

export function safeExportName(title: string): string {
  const value = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 60);
  return value || "视频发布资料";
}

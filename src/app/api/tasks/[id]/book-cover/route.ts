import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { safeTaskDir, isValidTaskId } from "@/lib/cleanup";
import { editArtifact, isTaskBusy } from "@/lib/pipeline";
import { imagesSchema } from "@/lib/domain";
import {
  applyBookShowcases,
  buildBookShowcaseConfig,
  ensureBookShowcaseConfig,
  loadBookShowcaseConfig,
  normalizeBookCover,
  readBookAssets,
  readImagesIfPresent,
  readRewriteIfPresent,
  readStoryboardIfPresent,
  restoreBookShowcases,
  saveBookCoverConfig,
  saveBookShowcaseConfig,
  type BookShowcaseConfig,
} from "@/lib/bookCover";

export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

async function validTask(id: string): Promise<boolean> {
  if (!isValidTaskId(id)) return false;
  return !!(await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)))[0];
}

async function markTaskPending(id: string): Promise<void> {
  await db
    .update(tasks)
    .set({ status: "pending", error: null, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(tasks.id, id));
}

async function applyToExistingImages(id: string, dir: string): Promise<{
  appliedBeatIds: number[];
  errors: string[];
}> {
  const items = await readImagesIfPresent(dir);
  if (!items) return { appliedBeatIds: [], errors: [] };
  try {
    const result = await applyBookShowcases(dir, items);
    await editArtifact(id, "images.json", imagesSchema.parse({ items: result.items }), "timelineBuild");
    await markTaskPending(id);
    return { appliedBeatIds: result.appliedBeatIds, errors: result.errors };
  } catch (error) {
    return {
      appliedBeatIds: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function rebuildPlacementForCurrentStoryboard(
  dir: string,
  sourceBook?: string
): Promise<BookShowcaseConfig | null> {
  const rewrite = await readRewriteIfPresent(dir);
  const board = await readStoryboardIfPresent(dir);
  if (!rewrite || !board) return null;
  const previous = await loadBookShowcaseConfig(dir);
  const config = await buildBookShowcaseConfig(
    sourceBook === undefined ? rewrite : { ...rewrite, sourceBook },
    board,
    previous
  );
  await saveBookShowcaseConfig(dir, config);
  return config;
}

/** GET /api/tasks/[id]/book-cover — 封面与推荐位置配置。 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!(await validTask(id))) {
    return NextResponse.json({ ok: false, error: "task not found" }, { status: 404 });
  }
  const assets = await readBookAssets(safeTaskDir(id));
  return NextResponse.json({ ok: true, ...assets });
}

/** POST multipart/form-data — 上传并规范化真实书籍封面。 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!(await validTask(id))) {
    return NextResponse.json({ ok: false, error: "task not found" }, { status: 404 });
  }
  if (isTaskBusy(id)) {
    return NextResponse.json({ ok: false, error: "任务正在处理中，请稍候再上传封面" }, { status: 409 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "请选择封面图片" }, { status: 400 });
  }
  const ext = extname(file.name).toLowerCase();
  if (!ALLOWED_MIME.has(file.type) && !ALLOWED_EXT.has(ext)) {
    return NextResponse.json({ ok: false, error: "封面支持 PNG、JPEG、WebP" }, { status: 400 });
  }
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ ok: false, error: "封面文件大小需在 15MB 以内" }, { status: 400 });
  }

  const dir = safeTaskDir(id);
  const bookDir = join(dir, "book");
  await mkdir(bookDir, { recursive: true });
  const uploadTemp = join(bookDir, `upload-${randomUUID()}.bin`);
  const coverPath = join(bookDir, "cover.png");
  try {
    await writeFile(uploadTemp, Buffer.from(await file.arrayBuffer()));
    const normalized = await normalizeBookCover(uploadTemp, coverPath);
    const savedRewrite = await readRewriteIfPresent(dir);
    const sourceBook =
      String(form.get("sourceBook") ?? "").trim() || savedRewrite?.sourceBook || "";
    const cover = {
      version: 1 as const,
      sourceBook,
      originalName: file.name,
      coverPath: "book/cover.png",
      sha256: normalized.sha256,
      width: normalized.width,
      height: normalized.height,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    await saveBookCoverConfig(dir, cover);
    const showcase = await rebuildPlacementForCurrentStoryboard(dir, sourceBook);
    const applied = await applyToExistingImages(id, dir);
    return NextResponse.json({ ok: true, cover, showcase, ...applied });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  } finally {
    await rm(uploadTemp, { force: true }).catch(() => {});
  }
}

/** PATCH — 人工确认推荐分镜及结尾展示开关，并立即重新应用本地封面。 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!(await validTask(id))) {
    return NextResponse.json({ ok: false, error: "task not found" }, { status: 404 });
  }
  if (isTaskBusy(id)) {
    return NextResponse.json({ ok: false, error: "任务正在处理中，请稍候再确认位置" }, { status: 409 });
  }
  const dir = safeTaskDir(id);
  const board = await readStoryboardIfPresent(dir);
  const current = await ensureBookShowcaseConfig(dir);
  if (!board || !current) {
    return NextResponse.json({ ok: false, error: "请先生成分镜" }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  if (body.reapply === true) {
    const applied = await applyToExistingImages(id, dir);
    return NextResponse.json({ ok: true, showcase: current, ...applied });
  }
  const selectedSceneId =
    body.selectedSceneId === null || body.selectedSceneId === undefined
      ? null
      : Number(body.selectedSceneId);
  const selectedScene =
    selectedSceneId === null
      ? null
      : board.scenes.find((scene) => scene.id === selectedSceneId) ?? null;
  if (selectedSceneId !== null && !selectedScene) {
    return NextResponse.json({ ok: false, error: "所选分镜不存在" }, { status: 400 });
  }

  const next: BookShowcaseConfig = {
    ...current,
    selectedSceneId,
    selectedSceneText: selectedScene?.text ?? "",
    selectionMode:
      selectedSceneId === null
        ? "ending-only"
        : selectedSceneId === current.autoCandidateSceneId
          ? "auto"
          : "manual",
    confirmed: true,
    showAtEnd: body.showAtEnd !== false,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  await saveBookShowcaseConfig(dir, next);
  const applied = await applyToExistingImages(id, dir);
  return NextResponse.json({ ok: true, showcase: next, ...applied });
}

/** DELETE — 删除封面并把已合成图片恢复为原场景图。 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!(await validTask(id))) {
    return NextResponse.json({ ok: false, error: "task not found" }, { status: 404 });
  }
  if (isTaskBusy(id)) {
    return NextResponse.json({ ok: false, error: "任务正在处理中，请稍候再删除封面" }, { status: 409 });
  }
  const dir = safeTaskDir(id);
  const items = await readImagesIfPresent(dir);
  if (items) {
    await editArtifact(
      id,
      "images.json",
      imagesSchema.parse({ items: restoreBookShowcases(items) }),
      "timelineBuild"
    );
    await markTaskPending(id);
  }
  await rm(join(dir, "book-cover.json"), { force: true }).catch(() => {});
  await rm(join(dir, "book"), { recursive: true, force: true }).catch(() => {});
  await rm(join(dir, "images", "book"), { recursive: true, force: true }).catch(() => {});
  return NextResponse.json({ ok: true });
}

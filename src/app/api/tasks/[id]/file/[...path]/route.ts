import { NextRequest } from "next/server";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";

export const dynamic = "force-dynamic";

const DATA_ROOT = resolve(process.env.DATA_ROOT ?? "./data");

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  json: "application/json",
  srt: "text/plain; charset=utf-8",
};

/**
 * GET /api/tasks/[id]/file/[...path] — 安全地提供任务目录下的产物文件。
 * 用于前端预览生图、播放配音、下载成片。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  const { id, path } = await params;
  const taskRoot = join(DATA_ROOT, "tasks", id);
  const rel = normalize(path.join("/")).replace(/^(\.\.[/\\])+/, "");
  const abs = join(taskRoot, rel);

  // 防目录穿越
  if (!abs.startsWith(taskRoot)) {
    return new Response("forbidden", { status: 403 });
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return new Response("not found", { status: 404 });
  }

  const ext = abs.split(".").pop()?.toLowerCase() ?? "";
  const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
  return new Response(stream, {
    headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" },
  });
}

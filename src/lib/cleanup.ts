import { resolve, join, sep } from "node:path";
import { readdir, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * 清理模块 —— 所有"删文件"的危险逻辑集中在此,统一上安全护栏。
 *
 * 两类清理:
 *  1) sweepWorkDirs:清渲染临时"孤儿工作目录"(ffwork- / work- 前缀)。渲染中断/崩溃后残留,纯废料。
 *  2) deleteTaskFiles:删整条任务目录(已发布/用完的任务腾空间)。
 *
 * 零误删护栏:
 *  - 任务ID必须是标准UUID;删除路径必须严格落在 <DATA_ROOT>/tasks/<uuid>/ 内(拒绝空值/../越界)。
 *  - 扫描只删名字为 ffwork-/work- 前缀的【子目录】,.mp4成品/图片/json 一律不碰。
 *  - 正在渲染用的工作目录登记在案(registerActiveWorkDir),扫描一律跳过。
 *  - 只清"够旧"的目录(mtime 早于阈值),避开"刚建还没登记"的竞态窗口。
 *  - 所有删除异常吞掉,绝不外抛拖垮渲染/应用。
 */

const DATA_ROOT = resolve(process.env.DATA_ROOT ?? "./data");
const TASKS_ROOT = join(DATA_ROOT, "tasks");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKDIR_RE = /^(ffwork|work)-/; // 只有这两种前缀的子目录才是临时废料

// ---- 活动工作目录登记:正在渲染写入的目录,清理必须跳过(主保护)----
const activeWorkDirs = new Set<string>();
export function registerActiveWorkDir(dir: string): void { activeWorkDirs.add(resolve(dir)); }
export function unregisterActiveWorkDir(dir: string): void { activeWorkDirs.delete(resolve(dir)); }

/** 任务ID是否合法(标准UUID) */
export function isValidTaskId(id: string): boolean {
  return typeof id === "string" && UUID_RE.test(id);
}

/** 返回任务绝对目录;非法ID或路径越界一律抛错(绝不返回可能越界的路径) */
export function safeTaskDir(id: string): string {
  if (!isValidTaskId(id)) throw new Error(`非法任务ID,拒绝删除: ${id}`);
  const dir = resolve(TASKS_ROOT, id);
  const rel = dir.slice(TASKS_ROOT.length);
  const parts = rel.split(sep).filter(Boolean);
  if (!dir.startsWith(TASKS_ROOT + sep) || rel.includes("..") || parts.length !== 1) {
    throw new Error(`路径越界,拒绝删除: ${dir}`);
  }
  return dir;
}

/** 递归统计目录字节数(容错) */
async function dirSize(p: string): Promise<number> {
  let total = 0;
  const entries = await readdir(p, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  for (const e of entries) {
    const full = join(p, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else total += (await stat(full).catch(() => null))?.size ?? 0;
  }
  return total;
}

/**
 * 扫描所有任务的 renders/,删除孤儿工作目录(ffwork- / work- 前缀)。
 * @param minAgeMs 只删修改时间早于此的目录(默认5分钟),配合活动登记双保险。
 */
export async function sweepWorkDirs(opts: { minAgeMs?: number } = {}): Promise<{ dirs: number; bytes: number }> {
  const minAgeMs = opts.minAgeMs ?? 5 * 60 * 1000;
  const now = Date.now();
  let dirs = 0, bytes = 0;
  if (!existsSync(TASKS_ROOT)) return { dirs, bytes };
  const taskIds = await readdir(TASKS_ROOT).catch(() => [] as string[]);
  for (const id of taskIds) {
    if (!isValidTaskId(id)) continue; // 只碰合法任务目录
    const rendersDir = join(TASKS_ROOT, id, "renders");
    if (!existsSync(rendersDir)) continue;
    const entries = await readdir(rendersDir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
    for (const e of entries) {
      if (!e.isDirectory()) continue;         // 只删目录,成品 .mp4 绝不碰
      if (!WORKDIR_RE.test(e.name)) continue; // 只删 ffwork-/work- 前缀
      const full = resolve(rendersDir, e.name);
      if (activeWorkDirs.has(full)) continue; // 保护:正在渲染
      const mtime = (await stat(full).catch(() => null))?.mtimeMs ?? now;
      if (now - mtime < minAgeMs) continue;   // 保护:太新可能正在写
      const sz = await dirSize(full);
      await rm(full, { recursive: true, force: true }).catch(() => {});
      if (!existsSync(full)) { dirs++; bytes += sz; }
    }
  }
  return { dirs, bytes };
}

/**
 * 删除整条任务的磁盘目录(路径安全校验后)。仅删文件;DB 记录由调用方删。
 * 调用方须已确认任务不在运行/排队(见 DELETE 接口)。
 */
export async function deleteTaskFiles(id: string): Promise<{ bytes: number }> {
  const dir = safeTaskDir(id); // 非法ID/越界会抛错,从根杜绝误删
  const bytes = existsSync(dir) ? await dirSize(dir) : 0;
  // maxRetries/retryDelay:应对 Windows 上刚释放的文件句柄(如视频预览)造成的瞬时 EPERM/EBUSY
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  return { bytes };
}

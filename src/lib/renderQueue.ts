import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks, steps as stepsTable } from "@/db/schema";
import { advanceTo, taskDir, isTaskBusy } from "./pipeline";

/**
 * 成片渲染队列 — 单进程内存队列 + 常驻串行 worker。
 *
 * 为什么串行(实测踩过的硬结论):
 *  - 内存:单条渲染 workers=2 就快撑满 4-6GB,并发必 OOM。
 *  - API 限流:StepFun 10RPM、gpt-image 并发限,账号级共享配额,并发抢配额触发 429。
 *  - 简单:一个 worker 循环即可,无需资源调度。
 *
 * 持久化:队列顺序只在内存(单进程),但任务 status=queued 落库。
 * 服务重启后内存队列丢失 → ensureQueueRecovered() 扫库把 queued 重新入队(自愈)。
 */

const now = () => Math.floor(Date.now() / 1000);

// running step 自恢复保护:
// dev/HMR 或服务重载时，内存里的 currentTaskId 可能丢失，但旧进程启动的 FFmpeg 仍在写日志。
// 因此不能一看到 DB 里有 running 就立即标失败；必须确认“足够久没有任何活动”。
// 僵尸态自愈:任务在 DB 里 running/queued,但内存里既没锁(isTaskBusy)也不在渲染队列,
// 且磁盘一段时间无活动 → 判定为"进程中断留下的僵尸",复位为 failed,让用户可重跑/补图,不再卡死点不动。
// 活动宽限期默认 3 分钟:期间有任何文件写入(日志/图片/切片)就认为仍在跑,保守不误杀。
const activeGraceSeconds = () => Number(process.env.RUNNING_STEP_ACTIVE_GRACE_SEC ?? 3 * 60);

/** 取路径 mtime(目录则递归取子项最新 mtime,深度2够覆盖 renders 下的 ffwork 工作目录及其切片)。找到 ≥cutoff 即真。 */
async function anyRecentMtime(p: string, cutoffMs: number, depth = 2): Promise<boolean> {
  const s = await stat(p).catch(() => null);
  if (!s) return false;
  if (s.mtimeMs >= cutoffMs) return true;
  if (s.isDirectory() && depth > 0) {
    const names = await readdir(p).catch(() => [] as string[]);
    for (const n of names) {
      if (await anyRecentMtime(join(p, n), cutoffMs, depth - 1)) return true;
    }
  }
  return false;
}

async function hasRecentTaskActivity(taskId: string, graceSec = activeGraceSeconds()): Promise<boolean> {
  const cutoffMs = Date.now() - graceSec * 1000;
  const paths = [
    join(taskDir(taskId), "pipeline.log"),
    join(taskDir(taskId), "final.mp4"),
    join(taskDir(taskId), "images"),
    join(taskDir(taskId), "renders"),
  ];
  for (const p of paths) {
    if (await anyRecentMtime(p, cutoffMs)) return true;
  }
  return false;
}

/**
 * 复位僵尸态:凡"内存无锁 + 不在渲染队列 + 磁盘无近期活动"的任务,一律把它的 running 步骤 + 任务
 * 都置 failed 并写明原因,使前端可重新操作。幂等、可反复调用。
 *
 * 关键:候选集 = (status 为 running/queued 的任务) ∪ (含 running 步骤的任务)。
 * 后者专门兜住"任务已 failed 但某步骤仍卡在 running"——前端按步骤状态判断,漏掉它就会一直转圈。
 * @returns 被复位的任务数
 */
export async function recoverOrphanTasks(): Promise<number> {
  const taskRows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(inArray(tasks.status, ["running", "queued"]))
    .catch(() => [] as { id: string }[]);
  const stepRows = await db
    .select({ taskId: stepsTable.taskId })
    .from(stepsTable)
    .where(eq(stepsTable.status, "running"))
    .catch(() => [] as { taskId: string }[]);
  const candidateIds = [...new Set([...taskRows.map((r) => r.id), ...stepRows.map((r) => r.taskId)])];

  const activeIds = new Set([currentTaskId, ...queue].filter((x): x is string => !!x));
  let fixed = 0;
  const msg = "上次运行被中断(进程重启/网络超时),已复位为失败,请重跑该步骤或点「补齐缺图」";
  for (const id of candidateIds) {
    if (activeIds.has(id) || isTaskBusy(id)) continue;   // 真在跑:内存锁或渲染队列 → 跳过
    if (await hasRecentTaskActivity(id)) continue;        // 磁盘近期有写入(如旧进程 ffmpeg)→ 保守跳过
    // 先复位卡住的步骤,再复位任务;两者都做,杜绝"任务 failed 但步骤仍 running"的转圈
    await db.update(stepsTable).set({ status: "failed", endedAt: now(), error: msg })
      .where(and(eq(stepsTable.taskId, id), eq(stepsTable.status, "running"))).catch(() => {});
    await db.update(tasks).set({ status: "failed", error: msg, updatedAt: now() })
      .where(eq(tasks.id, id)).catch(() => {});
    fixed++;
  }
  return fixed;
}

/** 节流版:会话中途轮询调用,最多每 30 秒真正扫一次库,避免 1.5s 轮询频繁扫库。 */
let lastOrphanScan = 0;
export async function recoverOrphanTasksThrottled(): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastOrphanScan < 30_000) return;
  lastOrphanScan = nowMs;
  const fixed = await recoverOrphanTasks().catch(() => 0);
  if (fixed > 0) console.log(`[recover] 轮询复位 ${fixed} 个僵尸任务`);
}

// 内存队列:待渲染的 taskId,FIFO
const queue: string[] = [];
let running = false; // worker 是否在跑
let currentTaskId: string | null = null; // 正在渲染的任务

/** 入队:标记 queued 落库 + 推入内存队列 + 启动 worker */
export async function enqueue(taskId: string): Promise<{ position: number }> {
  if (!queue.includes(taskId) && currentTaskId !== taskId) {
    queue.push(taskId);
  }
  await db
    .update(tasks)
    .set({ status: "queued", error: null, updatedAt: now() })
    .where(eq(tasks.id, taskId));
  void pump();
  return { position: queuePosition(taskId) };
}

/** 队列位次(1-based);正在渲染的返回 0;不在队列返回 -1 */
export function queuePosition(taskId: string): number {
  if (currentTaskId === taskId) return 0;
  const i = queue.indexOf(taskId);
  return i < 0 ? -1 : i + 1;
}

/** 队列快照(供首页展示) */
export function queueSnapshot(): { current: string | null; waiting: string[] } {
  return { current: currentTaskId, waiting: [...queue] };
}

/** 串行 worker:取队首 → advanceTo(final) → 成功/失败都取下一条。失败不阻塞队列。 */
async function pump(): Promise<void> {
  if (running) return; // 已有 worker 在跑,单例
  running = true;
  try {
    while (queue.length > 0) {
      const taskId = queue.shift()!;
      currentTaskId = taskId;
      try {
        await advanceTo(taskId, "final");
      } catch (e) {
        // 单条失败已由 advanceTo 内部标记 task failed;这里仅吞掉,继续下一条
        const msg = e instanceof Error ? e.message : String(e);
        await db
          .update(tasks)
          .set({ status: "failed", error: msg, updatedAt: now() })
          .where(eq(tasks.id, taskId))
          .catch(() => {});
      } finally {
        currentTaskId = null;
      }
    }
  } finally {
    running = false;
  }
  // 队列可能在 running=false 后又被 enqueue 推入,补一次
  if (queue.length > 0) void pump();
}

/**
 * 启动自愈:服务重启后内存队列丢失,扫库把 status=queued 的任务重新入队。
 * 幂等:模块加载时调用一次即可。
 */
let recovered = false;
export async function ensureQueueRecovered(): Promise<void> {
  if (recovered) return;
  recovered = true;
  // 启动时先清历史孤儿工作目录(渲染中断/崩溃后残留的废料);非阻塞、失败不影响启动
  const { sweepWorkDirs } = await import("./cleanup");
  void sweepWorkDirs().catch(() => {});

  // 启动时复位僵尸任务(进程中断留下的 running/queued),使前端可重新操作。
  // 安全:内存有锁/在渲染队列/磁盘近期有写入的任务一律跳过,不会误杀真在跑的。
  const fixed = await recoverOrphanTasks().catch(() => 0);
  if (fixed > 0) console.log(`[recover] 复位 ${fixed} 个僵尸任务(进程中断残留)`);

  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(inArray(tasks.status, ["queued"]))
    .catch(() => [] as { id: string }[]);
  for (const r of rows) {
    if (!queue.includes(r.id)) queue.push(r.id);
  }
  if (queue.length > 0) void pump();
}

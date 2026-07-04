import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { advanceTo } from "./pipeline";

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

/**
 * 持久化运行日志(阶段0)—— 报错/卡死能精准定位。
 *
 * 现状问题:日志只在内存里跑完即丢,失败只留一句 error,无堆栈无时间线。
 * 方案:每任务追加写 data/tasks/{id}/pipeline.log(JSON 行),同时留一份内存环形缓冲供 SSE 实时推送。
 *
 * 写入按任务串行链(保证行顺序);内存缓冲上限防泄漏。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";

const DATA_ROOT = resolve(process.env.DATA_ROOT ?? "./data");
const MAX_BUF = 500;

export type LogLevel = "info" | "warn" | "error";
export interface LogRecord {
  ts: number;
  level: LogLevel;
  step: string | null;
  msg: string;
  stack?: string;
}

const buffers = new Map<string, LogRecord[]>();
const writeChains = new Map<string, Promise<void>>();
// SSE 订阅者:taskId → 一组推送回调
const subscribers = new Map<string, Set<(rec: LogRecord) => void>>();

function logPath(taskId: string): string {
  return join(DATA_ROOT, "tasks", taskId, "pipeline.log");
}

/** 记一条日志:写内存缓冲 + 推 SSE + 串行追加落盘 */
export function logLine(
  taskId: string,
  entry: { level?: LogLevel; step?: string | null; msg: string; stack?: string }
): void {
  const rec: LogRecord = {
    ts: Date.now(),
    level: entry.level ?? "info",
    step: entry.step ?? null,
    msg: entry.msg,
    ...(entry.stack ? { stack: entry.stack } : {}),
  };

  // 内存环形缓冲
  let buf = buffers.get(taskId);
  if (!buf) {
    buf = [];
    buffers.set(taskId, buf);
  }
  buf.push(rec);
  if (buf.length > MAX_BUF) buf.shift();

  // 推给 SSE 订阅者
  const subs = subscribers.get(taskId);
  if (subs) for (const cb of subs) { try { cb(rec); } catch { /* 单个订阅者异常不影响其他 */ } }

  // 串行追加落盘(按任务链式,保证行顺序;不阻塞调用方)
  const line = JSON.stringify(rec) + "\n";
  const prev = writeChains.get(taskId) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const p = logPath(taskId);
      await mkdir(dirname(p), { recursive: true });
      await appendFile(p, line, "utf-8");
    } catch {
      /* 落盘失败不影响流水线 */
    }
  });
  writeChains.set(taskId, next);
}

/** 取内存缓冲里的历史日志(SSE 首次连接时回放) */
export function getBufferedLogs(taskId: string): LogRecord[] {
  return buffers.get(taskId) ? [...buffers.get(taskId)!] : [];
}

/** 订阅某任务的实时日志,返回取消订阅函数 */
export function subscribeLogs(taskId: string, cb: (rec: LogRecord) => void): () => void {
  let subs = subscribers.get(taskId);
  if (!subs) {
    subs = new Set();
    subscribers.set(taskId, subs);
  }
  subs.add(cb);
  return () => {
    subs!.delete(cb);
    if (subs!.size === 0) subscribers.delete(taskId);
  };
}

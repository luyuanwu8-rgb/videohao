/**
 * 全局资源调速器 —— 跨任务限流(阶段0)。
 *
 * 问题:多个任务同时跑到生图时,各自并发发请求 → 汇总并发打爆第三方(yunwu.ai/gpt-image),
 * 触发 429 风暴。StepFun 有自己的 gate,但 gpt-image / 豆包 没有。
 *
 * 方案:按 provider "键"共享一个信号量(限最大并发)+ 可选最小发射间隔。
 * 无论多少任务、每个任务内多少并发,同一 key 的在途请求数被全局限死。
 *
 * 用法:await withLimit("gptimage", () => 发请求())
 * 进程级单例;锁顺序始终"先任务锁后本调速器",无循环等待 → 无死锁。
 */

interface Slot {
  max: number;
  minGapMs: number;
  active: number;
  lastStart: number;
  waiters: Array<() => void>;
}

const slots = new Map<string, Slot>();

function slotFor(key: string): Slot {
  let s = slots.get(key);
  if (!s) {
    s = { max: 2, minGapMs: 0, active: 0, lastStart: 0, waiters: [] };
    slots.set(key, s);
  }
  return s;
}

/** 配置某 key 的并发上限与最小发射间隔(应用启动时按 env 配一次) */
export function configureLimiter(key: string, max: number, minGapMs = 0): void {
  const s = slotFor(key);
  s.max = Math.max(1, max);
  s.minGapMs = Math.max(0, minGapMs);
  // 上限调大后可能有等待者可放行
  drain(key);
}

/** 取一个发射许可(受并发上限 + 最小间隔约束) */
function acquire(key: string): Promise<void> {
  const s = slotFor(key);
  return new Promise<void>((resolve) => {
    const run = () => {
      s.active++;
      const now = Date.now();
      const wait = Math.max(0, s.lastStart + s.minGapMs - now);
      s.lastStart = Math.max(now, s.lastStart + s.minGapMs);
      if (wait > 0) setTimeout(resolve, wait);
      else resolve();
    };
    if (s.active < s.max) run();
    else s.waiters.push(run);
  });
}

function release(key: string): void {
  const s = slots.get(key);
  if (!s) return;
  s.active = Math.max(0, s.active - 1);
  drain(key);
}

function drain(key: string): void {
  const s = slots.get(key);
  if (!s) return;
  while (s.active < s.max && s.waiters.length > 0) {
    const next = s.waiters.shift()!;
    next();
  }
}

/** 在全局调速器约束下执行 fn(自动 acquire/release,异常也释放) */
export async function withLimit<T>(key: string, fn: () => Promise<T>): Promise<T> {
  await acquire(key);
  try {
    return await fn();
  } finally {
    release(key);
  }
}

/** 当前在途数(调试/监控用) */
export function activeCount(key: string): number {
  return slots.get(key)?.active ?? 0;
}

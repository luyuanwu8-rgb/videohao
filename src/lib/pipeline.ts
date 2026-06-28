import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks, steps as stepsTable, artifacts } from "@/db/schema";
import type { Task } from "@/db/schema";
import {
  PIPELINE_DEPS,
  PIPELINE_ORDER,
  type StepContext,
  type StepDef,
  type StepName,
} from "./steps/types";
import { STEP_REGISTRY } from "./steps";
import { CHECKPOINTS, stepsUpTo } from "./checkpoints";

const DATA_ROOT = resolve(process.env.DATA_ROOT ?? "./data");

export function taskDir(taskId: string): string {
  return join(DATA_ROOT, "tasks", taskId);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** 创建任务 + 初始化所有 step 行为 pending。
 * 传入 script 时走"自带文案"模式：把文案写成 rewrite.json，
 * 跳过 extract/transcribe/viralAnalyze/rewrite（标记 completed），流水线从 storyboard 起跑。 */
export async function createTask(input: {
  sourceUrl?: string;
  title?: string;
  track?: string;
  script?: string; // 自带定稿口播稿(方案B)
}): Promise<Task> {
  const id = randomUUID();
  const track = input.track ?? process.env.DEFAULT_TRACK ?? "health";
  const byoScript = (input.script ?? "").trim(); // bring-your-own script
  // 自带文案时，标题缺省取文案首句(≤20字)兜底
  const title =
    input.title ??
    (byoScript ? byoScript.replace(/\s+/g, "").slice(0, 20) : undefined);
  const [task] = await db
    .insert(tasks)
    .values({ id, sourceUrl: input.sourceUrl, title, track })
    .returning();

  // 自带文案模式：前4步视为已完成（跳过抖音解析+ASR+爆款分析+改写）
  const SKIP = new Set<StepName>(["extract", "transcribe", "viralAnalyze", "rewrite"]);
  await db.insert(stepsTable).values(
    PIPELINE_ORDER.map((name) => ({
      id: randomUUID(),
      taskId: id,
      name,
      status: (byoScript && SKIP.has(name) ? "completed" : "pending") as
        | "completed"
        | "pending",
      startedAt: byoScript && SKIP.has(name) ? now() : null,
      endedAt: byoScript && SKIP.has(name) ? now() : null,
    }))
  );
  await mkdir(taskDir(id), { recursive: true });

  // 自带文案：直接落 rewrite.json（storyboard 读它的 script 字段切句）
  if (byoScript) {
    const rewrite = {
      title: title ?? "",
      sourceBook: "", // 书名留到「选书+标题」环节填
      hooks: [],
      script: byoScript,
    };
    const abs = join(taskDir(id), "rewrite.json");
    await writeFile(abs, JSON.stringify(rewrite, null, 2), "utf-8");
    await registerArtifact(id, "rewrite.json", { fileType: "json", tag: "byo" });
  }
  return task;
}

/** 某 step 的依赖是否都已完成 */
async function depsSatisfied(taskId: string, name: StepName): Promise<boolean> {
  const deps = PIPELINE_DEPS[name];
  if (deps.length === 0) return true;
  const rows = await db
    .select()
    .from(stepsTable)
    .where(eq(stepsTable.taskId, taskId));
  const byName = new Map(rows.map((r) => [r.name, r.status]));
  return deps.every((d) => byName.get(d) === "completed");
}

function buildContext(task: Task, log: (m: string) => void): StepContext {
  const dir = taskDir(task.id);
  const mode = (process.env.PIPELINE_MODE === "real" ? "real" : "mock") as
    | "mock"
    | "real";
  let pendingCost = 0;
  let pendingUsage: Record<string, unknown> | undefined;

  return {
    task,
    taskDir: dir,
    track: task.track,
    mode,
    readArtifact: async (rel) => readFile(join(dir, rel), "utf-8"),
    readJSON: async (rel) =>
      JSON.parse(await readFile(join(dir, rel), "utf-8")),
    writeArtifact: async (rel, data, opts) => {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, data);
      await registerArtifact(task.id, rel, opts);
    },
    writeJSON: async (rel, data, opts) => {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, JSON.stringify(data, null, 2), "utf-8");
      await registerArtifact(task.id, rel, { ...opts, fileType: "json" });
    },
    registerArtifact: async (rel, opts) => {
      await registerArtifact(task.id, rel, opts);
    },
    reportCost: (cost, usage) => {
      pendingCost += cost;
      pendingUsage = usage ?? pendingUsage;
    },
    log,
  };
  // 注：pendingCost 在 runStep 内通过闭包读取写库（见下）。
}

async function registerArtifact(
  taskId: string,
  relPath: string,
  opts?: { fileType?: string; tag?: string; meta?: Record<string, unknown> }
) {
  // 版本号 = 同 (task, path) 已有记录数 + 1
  const existing = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.taskId, taskId), eq(artifacts.filePath, relPath)));
  const fileType = opts?.fileType ?? relPath.split(".").pop() ?? "bin";
  await db.insert(artifacts).values({
    id: randomUUID(),
    taskId,
    stepName: relPath.split("/")[0] ?? "unknown",
    filePath: relPath,
    fileType,
    version: existing.length + 1,
    tag: opts?.tag,
    meta: opts?.meta,
  });
}

/** 跑单个 step（支持重跑：会重置该 step 及其下游为 pending 由调用方决定） */
export async function runStep(
  taskId: string,
  name: StepName,
  onLog?: (m: string) => void
): Promise<{ ok: boolean; error?: string }> {
  // 确保 API 配置缓存已加载(前端可编辑的 api_configs → env() 同步读)
  const { ensureConfigLoaded } = await import("@/lib/config-cache");
  await ensureConfigLoaded();

  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  if (!task) return { ok: false, error: "task not found" };

  if (!(await depsSatisfied(taskId, name))) {
    return { ok: false, error: `deps not satisfied for ${name}` };
  }

  const def: StepDef | undefined = STEP_REGISTRY[name];
  if (!def) return { ok: false, error: `step not implemented: ${name}` };

  const logs: string[] = [];
  const log = (m: string) => {
    logs.push(m);
    onLog?.(m);
  };

  await db
    .update(stepsTable)
    .set({ status: "running", startedAt: now(), error: null })
    .where(and(eq(stepsTable.taskId, taskId), eq(stepsTable.name, name)));

  const ctx = buildContext(task, log);
  // 用闭包捕获 cost：重新包一层 reportCost
  let costAcc = 0;
  let usageAcc: Record<string, unknown> | undefined;
  ctx.reportCost = (c, u) => {
    costAcc += c;
    usageAcc = u ?? usageAcc;
  };

  try {
    const result = await def.run(ctx);
    await db
      .update(stepsTable)
      .set({
        status: result.ok ? "completed" : "failed",
        endedAt: now(),
        error: result.error ?? null,
        cost: costAcc,
        usage: usageAcc,
      })
      .where(and(eq(stepsTable.taskId, taskId), eq(stepsTable.name, name)));
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(stepsTable)
      .set({ status: "failed", endedAt: now(), error: msg, cost: costAcc })
      .where(and(eq(stepsTable.taskId, taskId), eq(stepsTable.name, name)));
    return { ok: false, error: msg };
  }
}

/**
 * 推进到指定检查点：按 checkpoint 顺序跑到目标检查点名下的最后一个内部 step 为止。
 * 已完成的 step 跳过(幂等);遇失败即停。用于"分步确认"工作台的"确认,下一步"。
 */
export async function advanceTo(
  taskId: string,
  checkpointKey: string,
  onLog?: (m: string) => void
): Promise<{ ok: boolean; failedAt?: StepName; error?: string }> {
  const targets = stepsUpTo(checkpointKey);
  if (targets.length === 0) return { ok: true }; // 纯配置检查点,无引擎步

  await db
    .update(tasks)
    .set({ status: "running", error: null, updatedAt: now() })
    .where(eq(tasks.id, taskId));

  const rows = await db.select().from(stepsTable).where(eq(stepsTable.taskId, taskId));
  const statusByName = new Map(rows.map((r) => [r.name as StepName, r.status]));

  for (const name of targets) {
    // 每步开始前检查是否已被暂停
    const taskNow = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    if (taskNow?.status === "paused") return { ok: true }; // 暂停：安静退出，不标失败
    if (statusByName.get(name) === "completed") continue; // 幂等跳过
    onLog?.(`▶ ${name}`);
    const res = await runStep(taskId, name, onLog);
    if (!res.ok) {
      await db
        .update(tasks)
        .set({ status: "failed", error: res.error, updatedAt: now() })
        .where(eq(tasks.id, taskId));
      return { ok: false, failedAt: name, error: res.error };
    }
  }

  // 跑到末检查点才算 completed,否则保持 running 以示"还有后续步"
  const isFinal = checkpointKey === CHECKPOINTS[CHECKPOINTS.length - 1].key;
  await db
    .update(tasks)
    .set({ status: isFinal ? "completed" : "running", updatedAt: now() })
    .where(eq(tasks.id, taskId));
  return { ok: true };
}

/**
 * 编辑某产物 json:写盘 + 登记新版本 + 把依赖它的下游 step 重置为 pending。
 * 用于工作台"改了上游产物→下游失效需重跑"。fromStep 是该产物所属/下游起点 step。
 */
export async function editArtifact(
  taskId: string,
  relPath: string,
  data: unknown,
  invalidateFrom?: StepName
): Promise<void> {
  const dir = taskDir(taskId);
  const abs = join(dir, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(data, null, 2), "utf-8");
  await registerArtifact(taskId, relPath, { fileType: "json", tag: "edited" });

  if (invalidateFrom) {
    const downstream = collectDownstream(invalidateFrom);
    for (const name of [invalidateFrom, ...downstream]) {
      await db
        .update(stepsTable)
        .set({ status: "pending", error: null, startedAt: null, endedAt: null })
        .where(and(eq(stepsTable.taskId, taskId), eq(stepsTable.name, name)));
    }
  }
}

/** 收集某 step 的所有下游(递归) */
function collectDownstream(step: StepName): StepName[] {
  const out = new Set<StepName>();
  const stack = [step];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const [name, deps] of Object.entries(PIPELINE_DEPS) as [StepName, StepName[]][]) {
      if (deps.includes(cur) && !out.has(name)) {
        out.add(name);
        stack.push(name);
      }
    }
  }
  return [...out];
}

/** 跑整条流水线：按 DAG 拓扑顺序，依赖满足就跑，失败即停 */
export async function runPipeline(
  taskId: string,
  onLog?: (m: string) => void
): Promise<{ ok: boolean; failedAt?: StepName; error?: string }> {
  await db
    .update(tasks)
    .set({ status: "running", updatedAt: now() })
    .where(eq(tasks.id, taskId));

  for (const name of PIPELINE_ORDER) {
    onLog?.(`▶ ${name}`);
    const res = await runStep(taskId, name, onLog);
    if (!res.ok) {
      await db
        .update(tasks)
        .set({ status: "failed", error: res.error, updatedAt: now() })
        .where(eq(tasks.id, taskId));
      return { ok: false, failedAt: name, error: res.error };
    }
  }

  await db
    .update(tasks)
    .set({ status: "completed", updatedAt: now() })
    .where(eq(tasks.id, taskId));
  return { ok: true };
}

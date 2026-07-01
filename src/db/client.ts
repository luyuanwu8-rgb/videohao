import "@/lib/loadenv";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";

const DB_PATH = process.env.DB_PATH ?? "./data/app.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const client = createClient({ url: `file:${resolve(DB_PATH)}` });

/**
 * 数据库就绪 promise —— 并发/写一致性加固(阶段0)。
 * - journal_mode=WAL:读写不互相阻塞(库文件属性,设一次持久),根治多任务并发写的 SQLITE_BUSY。
 * - busy_timeout=5000:连接级,写锁竞争时最多等 5s 再报错,而非立即失败。
 * 首次查询前应 await dbReady(runStep 开头统一 await),避免 pragma 未生效就查询。
 */
export const dbReady: Promise<void> = (async () => {
  try {
    await client.execute("PRAGMA journal_mode=WAL");
    await client.execute("PRAGMA busy_timeout=5000");
  } catch {
    /* pragma 失败不致命,退回默认 journal 模式 */
  }
})();

export const db = drizzle(client, { schema });
export { schema };

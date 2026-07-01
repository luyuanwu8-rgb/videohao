import "@/lib/loadenv";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "./data/app.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const client = createClient({ url: `file:${resolve(DB_PATH)}` });
const db = drizzle(client);

// WAL 是库文件属性,设一次持久化(此处顺带设,与 client.ts 双保险)
try {
  await client.execute("PRAGMA journal_mode=WAL");
} catch {
  /* 忽略:pragma 失败退回默认 journal */
}
await migrate(db, { migrationsFolder: "./drizzle" });
console.log("migrations applied");

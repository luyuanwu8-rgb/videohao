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

await migrate(db, { migrationsFolder: "./drizzle" });
console.log("migrations applied");

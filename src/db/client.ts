import "@/lib/loadenv";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";

const DB_PATH = process.env.DB_PATH ?? "./data/app.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const client = createClient({ url: `file:${resolve(DB_PATH)}` });

export const db = drizzle(client, { schema });
export { schema };

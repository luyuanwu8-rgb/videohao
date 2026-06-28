/**
 * 环境变量加载（供 tsx 脚本和 Next 之外的入口用）。
 * 优先级：.env.local 覆盖 .env，与 Next.js 行为一致。
 *
 * Next.js 运行时会自动加载这两个文件，无需 import 本模块；
 * 但独立 tsx 脚本（smoke/migrate/test-*）不经 Next，需显式 import。
 */
import { config } from "dotenv";

config({ path: ".env" });
config({ path: ".env.local", override: true });

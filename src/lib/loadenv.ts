/**
 * 环境变量加载（供 tsx 脚本和 Next 之外的入口用）。
 * 优先级：.env.local 覆盖 .env，与 Next.js 行为一致。
 *
 * Next.js 运行时会自动加载这两个文件，无需 import 本模块；
 * 但独立 tsx 脚本（smoke/migrate/test-*）不经 Next，需显式 import。
 */
import { config } from "dotenv";

// 命令行/服务管理器显式传入的变量优先级最高，尤其是
// PIPELINE_MODE=mock；否则 .env.local 的 real 会让本地测试误发付费请求。
const inheritedEnv = { ...process.env };
config({ path: ".env" });
config({ path: ".env.local", override: true });
for (const [key, value] of Object.entries(inheritedEnv)) {
  if (value !== undefined) process.env[key] = value;
}

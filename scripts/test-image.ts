import "@/lib/loadenv";
import { generate } from "@/lib/providers/gptimage";
import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 验证 gpt-image real 分支（yunwu.ai 中转）。
 * 用法: npx tsx scripts/test-image.ts
 */
async function main() {
  const dir = resolve("data/_imgtest");
  mkdirSync(dir, { recursive: true });
  const dest = resolve(dir, "test.png");
  const prompt =
    "竖版9:16，写实温暖的健康科普画面：一位中老年女性安详地躺在床上睡觉，" +
    "卧室柔和暖光，窗外夜色，画面宁静可信，无文字水印";

  console.log("请求 yunwu.ai 生图…");
  const t0 = Date.now();
  const { cost } = await generate(prompt, dest, { width: 1080, height: 1920 }, "real");
  const size = statSync(dest).size;
  console.log(`成功: ${dest}`);
  console.log(`大小: ${(size / 1024).toFixed(1)} KB | 耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s | 成本: ${cost}`);
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});

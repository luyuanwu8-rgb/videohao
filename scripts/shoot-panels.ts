import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

/**
 * 工作台 9 检查点截图脚本（只读浏览，不点编辑/确认等破坏性按钮）。
 * 用法: npx tsx scripts/shoot-panels.ts <taskId>
 * 截图输出到 data/_shots/。
 */
const taskId = process.argv[2];
if (!taskId) throw new Error("用法: tsx scripts/shoot-panels.ts <taskId>");

const PANELS = [
  "parse", "transcript", "rewrite", "book", "storyboard",
  "tts", "image", "style", "final",
];

const outDir = "E:/Codex/videohao/data/_shots";
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const base = "http://localhost:3000";

await page.goto(`${base}/tasks/${taskId}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500); // 等首次 detail 加载

// 左侧导航按钮文案 = 检查点 label，用序号+label 点击
const LABELS = ["解析", "逐字稿", "改写", "选书", "分镜", "配音", "场景图", "风格运镜", "成片"];

for (let i = 0; i < PANELS.length; i++) {
  try {
    // 点左侧第 i 个检查点按钮（按可见文字匹配）
    const btn = page.locator("aside button", { hasText: LABELS[i] }).first();
    await btn.click({ timeout: 5000 });
    await page.waitForTimeout(900);
    const file = `${outDir}/${i + 1}_${PANELS[i]}.png`;
    await page.screenshot({ path: file });
    console.log(`✓ ${i + 1} ${LABELS[i]} -> ${file}`);
  } catch (e) {
    console.log(`✗ ${i + 1} ${LABELS[i]} 失败: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
  }
}

await browser.close();
console.log("截图完成 ->", outDir);

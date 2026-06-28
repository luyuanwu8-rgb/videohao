import "@/lib/loadenv";
import { generateGrid, sliceGrid } from "@/lib/providers/gptimage";
import { mkdirSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * 验证九宫格出图链路：一次出 3×3 网格图 → 裁成 9 张单格。
 * 用法: npx tsx scripts/test-grid.ts
 */
function dims(p: string): string {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", p],
    { encoding: "utf8", shell: process.platform === "win32" }
  );
  return (r.stdout || "").trim();
}

async function main() {
  const dir = resolve("data/_gridtest");
  mkdirSync(dir, { recursive: true });
  const gridPath = resolve(dir, "grid.png");

  const cells = [
    "中老年女性安详地在卧室睡觉，暖光",
    "厨房里一碗温热的小米粥，蒸汽袅袅",
    "清晨公园里老人散步锻炼",
    "医生与患者温和交谈",
    "一本翻开的健康书籍特写",
    "全家人围坐餐桌吃饭",
    "夜晚台灯下读书的老人",
    "窗台上一杯热牛奶",
    "老人微笑着竖起大拇指",
  ];
  const gridPrompt =
    "生成一张 3×3 九宫格拼图，9 个独立画面等分排列（从左到右、从上到下编号 1-9），" +
    "格与格之间无边框、无间隙、无文字水印，每格都是完整独立的 9:16 竖版写实温暖健康科普画面。各格如下：\n" +
    cells.map((c, i) => `第${i + 1}格：${c}`).join("\n");

  console.log("请求九宫格出图(1024x1536)…");
  const t0 = Date.now();
  const { cost } = await generateGrid(gridPrompt, gridPath, "1024x1536", "real");
  console.log(`网格图: ${gridPath} | ${dims(gridPath)} | 成本 ${cost} | ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const destPaths = cells.map((_, i) => resolve(dir, `cell_${i + 1}.png`));
  await sliceGrid(gridPath, destPaths, "real");

  let ok = 0;
  for (const p of destPaths) {
    if (existsSync(p)) {
      const kb = (statSync(p).size / 1024).toFixed(0);
      console.log(`  ${p.split(/[\\/]/).pop()} | ${dims(p)} | ${kb} KB`);
      ok++;
    } else {
      console.log(`  缺失: ${p}`);
    }
  }
  console.log(`\n裁切完成: ${ok}/9 张单格`);
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});

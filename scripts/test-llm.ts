import "@/lib/loadenv";
import { chat, extractJson } from "@/lib/providers/llm";
import { loadPrompt } from "@/lib/prompts";

/**
 * 验证 DeepSeek LLM real 分支：跑 viralAnalyze → rewrite → storyboard。
 * 用法: npx tsx scripts/test-llm.ts
 */
const TRANSCRIPT =
  "很多人觉得睡前饿肚子是亏待自己，其实刚好相反。空腹入睡能启动细胞自噬和代谢修复，" +
  "还能提升睡眠质量。不用花钱不用折腾，只要改掉睡前吃东西的习惯，身体就能获得一整晚的自我养护。";

async function main() {
  const track = "health";

  console.log("=== 1) viralAnalyze ===");
  const p1 = await loadPrompt("viralAnalyze", track);
  const r1 = await chat(p1.system, p1.build({ transcript: TRANSCRIPT }), "real", { json: true });
  const viral = JSON.parse(extractJson(r1.content));
  console.log(JSON.stringify(viral, null, 2));

  console.log("\n=== 2) rewrite (health 赛道) ===");
  const p2 = await loadPrompt("rewrite", track);
  const r2 = await chat(p2.system, p2.build({ transcript: TRANSCRIPT, viral }), "real", { json: true });
  const rw = JSON.parse(extractJson(r2.content));
  console.log("标题:", rw.title);
  console.log("反推书名:", rw.sourceBook);
  console.log("口播稿:", rw.script);

  console.log("\n=== 3) storyboard ===");
  const p3 = await loadPrompt("storyboard", track);
  const r3 = await chat(p3.system, p3.build({ script: rw.script }), "real", { json: true });
  const board = JSON.parse(extractJson(r3.content));
  console.log(`分镜 ${board.scenes.length} 个:`);
  for (const s of board.scenes) {
    console.log(`  #${s.id} [${s.estDuration}s] 文:${s.text}`);
    console.log(`        画面:${s.visual}`);
  }
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});

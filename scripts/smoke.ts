import "@/lib/loadenv";
import { createTask, runPipeline, taskDir } from "@/lib/pipeline";

/**
 * 端到端 mock 验证：不依赖 UI，直接跑通整条 11 步流水线。
 * 用法: npm run pipeline:smoke
 */
async function main() {
  process.env.PIPELINE_MODE = process.env.PIPELINE_MODE ?? "mock";
  console.log(`PIPELINE_MODE = ${process.env.PIPELINE_MODE}\n`);

  const task = await createTask({
    sourceUrl: "https://v.douyin.com/mock-share-link/",
    track: process.env.DEFAULT_TRACK ?? "health",
  });
  console.log(`created task: ${task.id}\n`);

  const result = await runPipeline(task.id, (m) => console.log("   " + m));

  console.log("\n=== 结果 ===");
  console.log(JSON.stringify(result, null, 2));
  console.log(`产物目录: ${taskDir(task.id)}`);

  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

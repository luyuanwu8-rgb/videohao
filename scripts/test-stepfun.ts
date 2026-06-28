import "@/lib/loadenv";
import { synthesize, transcribe } from "@/lib/providers/stepfun";
import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * StepFun 往返验证：TTS 合成语音 → ASR 转回文字。
 * 用法: npx tsx scripts/test-stepfun.ts
 */
async function main() {
  const dir = resolve("data/_stepfuntest");
  mkdirSync(dir, { recursive: true });
  const audio = resolve(dir, "voice.mp3");
  const text = "很多人觉得睡前饿肚子是亏待自己，其实刚好相反。";

  console.log("=== 1) TTS 合成 ===");
  console.log("输入文字:", text);
  const t0 = Date.now();
  const { duration } = await synthesize(text, audio, "real");
  console.log(`配音生成: ${audio}`);
  console.log(`大小 ${(statSync(audio).size / 1024).toFixed(1)} KB | 时长 ${duration.toFixed(2)}s | 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log("\n=== 2) ASR 转写（把刚才的配音转回文字）===");
  const t1 = Date.now();
  const { result } = await transcribe(audio, "real");
  console.log(`识别结果: ${result.text}`);
  console.log(`耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});

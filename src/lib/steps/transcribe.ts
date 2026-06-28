import { join } from "node:path";
import type { StepDef } from "./types";
import { transcribe as asr } from "@/lib/providers/stepfun";
import { transcriptSchema } from "@/lib/domain";

/**
 * transcribe: 抖音视频音频 → 逐字稿 (StepFun ASR)。
 * 只取文字；字幕对齐改为按 TTS 时长比例切分，不依赖词级时间戳。
 */
export const transcribe: StepDef = {
  name: "transcribe",
  deps: ["extract"],
  output: "transcript.json",
  run: async (ctx) => {
    // mock 模式没有真实音频，直接传占位路径；real 模式用 source.mp4
    const audioPath = join(ctx.taskDir, "source.mp4");
    const { result, cost } = await asr(audioPath, ctx.mode);
    ctx.reportCost(cost, { provider: "stepfun", model: "asr" });

    const transcript = transcriptSchema.parse(result);
    if (ctx.mode === "real" && !transcript.text.trim()) {
      return { ok: false, error: "转写为空：ASR 未返回任何文字" };
    }
    await ctx.writeJSON("transcript.json", transcript);
    ctx.log(`逐字稿: ${transcript.text.length} 字 (StepFun ASR)`);
    return { ok: true };
  },
};

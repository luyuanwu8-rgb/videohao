import "@/lib/loadenv";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { timelineSchema, type Timeline } from "@/lib/timeline";
import { renderTimeline } from "@/hyperframes/render";

/**
 * 独立验证 render.ts 的 real 分支：用真实素材构造 timeline → 渲出 mp4。
 * 用法: npx tsx scripts/test-render.ts
 */
const taskDir = resolve("data/_rendertest");

const subs = [
  "很多人觉得睡前饿肚子是亏待自己，其实刚好相反",
  "这本书讲透了空腹入睡背后的科学原理",
  "不用花钱不用折腾，身体就能获得整晚养护",
];
const durs = [3, 4, 5]; // 与生成的音频时长一致

const tracks: Timeline["tracks"] = [];
let cursor = 0;
for (let i = 0; i < 3; i++) {
  const id = i + 1;
  tracks.push({
    type: "image",
    src: `images/${id}.png`,
    start: cursor,
    duration: durs[i],
    zoom: { from: 1.0, to: 1.08 },
    sceneId: id,
  });
  tracks.push({
    type: "audio",
    src: `voice/${id}.wav`,
    start: cursor,
    duration: durs[i],
    volume: 1,
    role: "voice",
  });
  cursor += durs[i];
}
tracks.push({
  type: "subtitle",
  cues: durs.map((d, i) => {
    const start = durs.slice(0, i).reduce((a, b) => a + b, 0);
    return { start, end: start + d, text: subs[i] };
  }),
  style: { fontFamily: "HeiCN", fontSize: 18, color: "#FFDE00", marginV: 220 },
});

const timeline = timelineSchema.parse({
  version: 1,
  width: 1080,
  height: 1920,
  fps: 30,
  duration: cursor,
  tracks,
});

async function main() {
  console.log(`渲染工作区: ${taskDir} | 总时长 ${cursor}s`);
  const result = await renderTimeline({
    timeline,
    taskDir,
    outRel: "final.mp4",
    mode: "real",
    log: (m) => console.log("  " + m),
  });
  console.log("\n=== 结果 ===", JSON.stringify(result));
  const out = resolve(taskDir, "final.mp4");
  if (result.ok && existsSync(out)) {
    console.log(`成片: ${out} (${(statSync(out).size / 1024).toFixed(1)} KB)`);
  } else {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

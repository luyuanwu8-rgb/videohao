import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  readPublishKit,
  savePublishKitEdits,
  triggerPublishKit,
} from "@/lib/publishKit";
import { ensureConfigLoaded } from "@/lib/config-cache";

const expectedRoot = resolve(".tmp-publish-kit-smoke");
const configuredRoot = resolve(process.env.DATA_ROOT ?? "");
assert.equal(
  configuredRoot,
  expectedRoot,
  "请将 DATA_ROOT 指向项目内的 .tmp-publish-kit-smoke"
);
assert.equal(process.env.PIPELINE_MODE, "mock", "冒烟测试必须使用 mock 模式");

// 独立 tsx 入口在首次读数据库配置时会加载 .env.local。
// 先完成该初始化，再锁回 mock，确保后续没有外部模型调用。
await ensureConfigLoaded();
process.env.PIPELINE_MODE = "mock";

const taskId = "11111111-1111-4111-8111-111111111111";
const taskDir = join(configuredRoot, "tasks", taskId);
const rewritePath = join(taskDir, "rewrite.json");

await rm(configuredRoot, { recursive: true, force: true });
await mkdir(taskDir, { recursive: true });

const rewrite = {
  title: "那些藏在日常里的中国智慧",
  sourceBook: "《中国文化1000问》",
  hooks: [],
  script:
    "很多习以为常的生活细节，背后都藏着中国人的经验和智慧。理解这些来龙去脉，不只是增长知识，也是在重新认识我们的文化。说到这里，是因为《中国文化1000问》把许多问题讲得清楚，适合放在手边慢慢翻。",
};
await writeFile(rewritePath, JSON.stringify(rewrite, null, 2), "utf-8");

const first = triggerPublishKit(taskId, "all");
assert.equal(first.started, true);
await first.job;

const generated = await readPublishKit(taskId);
assert(generated, "应生成 publish-kit.json");
assert.equal(generated.status, "completed");
assert.equal(generated.cover.status, "completed");
assert(generated.cover.path, "应生成独立封面路径");
assert(
  generated.tags.some((item) => item.text === "#中国文化1000问"),
  "应包含书籍名标签"
);
assert.equal(generated.fullScript, rewrite.script);

const coverPath = join(taskDir, generated.cover.path);
const beforeCover = await stat(coverPath);
const second = triggerPublishKit(taskId, "all");
await second.job;
const afterRepeat = await readPublishKit(taskId);
const afterCover = await stat(coverPath);
assert(afterRepeat);
assert.equal(afterRepeat.cover.generatedAt, generated.cover.generatedAt);
assert.equal(afterCover.mtimeMs, beforeCover.mtimeMs, "重复触发不应重做封面");

const editedScript = `${rewrite.script}\n\n这是仅用于导出TXT的人工补充。`;
const edited = await savePublishKitEdits(taskId, {
  fullScript: editedScript,
  tags: ["#生活智慧"],
});
assert.equal(edited.fullScript, editedScript);
assert.equal(edited.title, generated.title);
assert(
  edited.tags.some((item) => item.text === "#中国文化1000问"),
  "人工编辑标签后仍应保留书籍名标签"
);
assert.deepEqual(
  JSON.parse(await readFile(rewritePath, "utf-8")),
  rewrite,
  "编辑完整文案不应回写 rewrite.json"
);

console.log(
  JSON.stringify(
    {
      ok: true,
      status: edited.status,
      mandatoryBookTag: "#中国文化1000问",
      coverGeneratedOnce: true,
      rewriteUntouched: true,
    },
    null,
    2
  )
);

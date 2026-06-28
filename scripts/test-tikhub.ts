import "@/lib/loadenv";
import { fetchVideo, downloadVideo, parseShareInput } from "@/lib/providers/tikhub";
import { statSync } from "node:fs";

const SHARE = process.argv[2] ?? "";

async function main() {
  console.log("提取链接:", parseShareInput(SHARE));
  const meta = await fetchVideo(SHARE, "real");
  console.log("\n=== TikHub 真实返回 ===");
  console.log("标题:", meta.title);
  console.log("作者:", meta.author);
  console.log("aweme_id:", meta.awemeId);
  console.log("播放/点赞/评论:", meta.stats.plays, "/", meta.stats.likes, "/", meta.stats.comments);
  console.log("无水印直链:", meta.videoUrl.slice(0, 90));
  console.log("封面:", meta.coverUrl.slice(0, 90));

  console.log("\n=== 测试下载视频 ===");
  const dest = "data/_test_download.mp4";
  await downloadVideo(meta.videoUrl, dest, "real");
  const size = statSync(dest).size;
  console.log(`下载成功: ${dest} (${(size / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});

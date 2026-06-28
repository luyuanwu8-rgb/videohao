import { env, requireEnv, type Mode } from "./base";

/**
 * TikHub 抖音解析。
 * 分享链接 → aweme_id → 无水印视频 URL + 元数据。
 *
 * 真实接口（real 模式）尚未接通，留 TODO；当前 mock 返回占位。
 */

export interface DouyinMeta {
  awemeId: string;
  title: string;
  author: string;
  stats: { plays?: number; likes?: number; comments?: number };
  videoUrl: string; // 无水印直链
  coverUrl: string;
}

/** 从分享文本/短链中提取可解析的链接或 id（mock 下宽松处理） */
export function parseShareInput(raw: string): string {
  const m = raw.match(/https?:\/\/\S+/);
  return m ? m[0] : raw.trim();
}

export async function fetchVideo(
  shareInput: string,
  mode: Mode
): Promise<DouyinMeta> {
  if (mode === "mock") {
    return {
      awemeId: "mock-" + Math.random().toString(36).slice(2, 10),
      title: "连续36小时不吃饭，身体会发生什么变化？",
      author: "健康科普老张",
      stats: { plays: 1280000, likes: 53000, comments: 2100 },
      videoUrl: "mock://video.mp4",
      coverUrl: "mock://cover.jpg",
    };
  }

  // === real 模式 ===
  // GET {base}/api/v1/douyin/web/fetch_one_video_by_share_url?share_url=...
  // Authorization: Bearer {key}
  // 响应字段路径（已对 demo 端点验证）：
  //   data.aweme_detail.desc                    → 标题
  //   data.aweme_detail.aweme_id                → id
  //   data.aweme_detail.author.nickname         → 作者
  //   data.aweme_detail.statistics.{play_count,digg_count,comment_count}
  //   data.aweme_detail.video.play_addr.url_list[0]  → 无水印直链
  //   data.aweme_detail.video.cover.url_list[0]      → 封面
  const baseUrl = env("TIKHUB_BASE_URL", "https://api.tikhub.io");
  const key = requireEnv("TIKHUB_API_KEY");
  const link = parseShareInput(shareInput);

  const url =
    `${baseUrl}/api/v1/douyin/web/fetch_one_video_by_share_url` +
    `?share_url=${encodeURIComponent(link)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`tikhub fetchVideo HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = (await resp.json()) as TikHubResponse;
  if (json.code !== 200 || !json.data?.aweme_detail) {
    throw new Error(`tikhub fetchVideo 业务失败: code=${json.code} ${json.message ?? ""}`);
  }

  const aw = json.data.aweme_detail;
  const st = aw.statistics ?? {};
  const playList = aw.video?.play_addr?.url_list ?? [];
  const coverList = aw.video?.cover?.url_list ?? [];
  return {
    awemeId: String(aw.aweme_id ?? ""),
    title: aw.desc ?? "",
    author: aw.author?.nickname ?? "",
    stats: {
      plays: st.play_count ?? undefined,
      likes: st.digg_count ?? undefined,
      comments: st.comment_count ?? undefined,
    },
    videoUrl: playList[playList.length - 1] ?? playList[0] ?? "",
    coverUrl: coverList[0] ?? "",
  };
}

/** TikHub fetch_one_video_by_share_url 响应（仅声明用到的字段） */
interface TikHubResponse {
  code: number;
  message?: string;
  data?: {
    aweme_detail?: {
      aweme_id?: string | number;
      desc?: string;
      author?: { nickname?: string };
      statistics?: {
        play_count?: number;
        digg_count?: number;
        comment_count?: number;
      };
      video?: {
        play_addr?: { url_list?: string[] };
        cover?: { url_list?: string[] };
      };
    };
  };
}

/** 下载无水印视频到本地（real 模式），3 次指数退避 */
export async function downloadVideo(
  url: string,
  destPath: string,
  mode: Mode
): Promise<void> {
  if (mode === "mock") {
    return; // mock 不落实际视频；占位文件由 step 决定是否写
  }
  if (!url || url.startsWith("mock://")) {
    throw new Error("downloadVideo: 无效视频地址");
  }
  const { writeFile } = await import("node:fs/promises");
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        // 抖音 CDN 需要一个常规 UA + referer，否则可能 403
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: "https://www.douyin.com/",
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      await writeFile(destPath, buf);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error(
    `downloadVideo 失败(3次): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

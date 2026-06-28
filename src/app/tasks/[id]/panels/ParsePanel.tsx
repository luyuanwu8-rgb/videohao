"use client";

import { useState } from "react";
import { T, btn } from "../../../ui/theme";
import { advance, PanelShell, type PanelProps } from "./shared";

/** ①解析 — 展示抖音元数据(只读快照),确认后进入逐字稿 */
export function ParsePanel({ taskId, detail, reload, navigate }: PanelProps) {
  const [busy, setBusy] = useState(false);
  const meta = detail.task.sourceMeta ?? {};
  const get = (k: string) => {
    const v = meta[k];
    return v == null ? "" : String(v);
  };
  const cover = get("coverUrl") || get("cover") || get("origin_cover");
  const author = get("author") || get("nickname");
  const plays = get("plays") || get("play_count");

  const rows: [string, string][] = [
    ["标题", detail.task.title ?? get("title")],
    ["作者", author],
    ["播放量", plays],
    ["赛道", detail.task.track],
    ["来源", detail.task.sourceUrl ?? ""],
  ];

  const parsed = detail.steps.find((s) => s.name === "extract")?.status === "completed";

  async function next() {
    setBusy(true);
    await advance(taskId, "transcript");
    reload();
    navigate("transcript");
    setBusy(false);
  }

  return (
    <PanelShell
      title="① 解析"
      hint="确认抖音视频信息抓取正确，再进入逐字稿。"
      footer={
        <button onClick={next} disabled={busy || !parsed} style={btn("primary")}>
          {busy ? "处理中…" : "确认，生成逐字稿 →"}
        </button>
      }
    >
      {!parsed ? (
        <p style={{ color: T.textSoft }}>正在解析抖音链接…</p>
      ) : (
        <div style={{ display: "flex", gap: 24 }}>
          {cover && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cover}
              alt="封面"
              style={{
                width: 200,
                borderRadius: 12,
                border: `1px solid ${T.border}`,
                objectFit: "cover",
              }}
            />
          )}
          <table style={{ borderCollapse: "collapse", fontSize: 14 }}>
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}>
                  <td
                    style={{
                      color: T.textSoft,
                      padding: "8px 18px 8px 0",
                      verticalAlign: "top",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {k}
                  </td>
                  <td style={{ color: T.text, padding: "8px 0", maxWidth: 420 }}>
                    {v || <span style={{ color: T.textFaint }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelShell>
  );
}

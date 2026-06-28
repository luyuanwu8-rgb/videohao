"use client";

import { useEffect, useState } from "react";
import { T, btn } from "../../../ui/theme";
import { advance, useArtifact, PanelShell, type PanelProps } from "./shared";
import { motionPreset } from "@/lib/motions";

type Source = { title?: string; author?: string };
type Rewrite = { title?: string; sourceBook?: string; hooks?: string[] };

/** 从抖音原标题拆出：正文(去#话题) + 话题标签数组 */
function splitTitle(raw: string): { body: string; tags: string[] } {
  const tags = (raw.match(/#[^#\s]+/g) ?? []).map((t) => t.trim());
  const body = raw.replace(/#[^#\s]+/g, "").trim();
  return { body, tags };
}

/** ⑨成片 — 预览 + 下载 + 发布物料(文案/话题/一键复制) */
export function FinalPanel({ taskId, detail, reload }: PanelProps) {
  const read = useArtifact();
  const [busy, setBusy] = useState(false);
  const [src, setSrc] = useState<Source | null>(null);
  const [rw, setRw] = useState<Rewrite | null>(null);
  const [copied, setCopied] = useState<string>("");

  const status = detail.steps.find((s) => s.name === "render")?.status;
  const done = status === "completed";

  useEffect(() => {
    read<Source>(taskId, "source.json").then((x) => x && setSrc(x));
    read<Rewrite>(taskId, "rewrite.json").then((x) => x && setRw(x));
  }, [taskId, read]);

  async function rebuild() {
    setBusy(true);
    await advance(taskId, "final");
    reload();
    setBusy(false);
  }

  function copy(key: string, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(""), 1500);
    });
  }

  // 发布物料组装（零 AI：复用原标题+话题）
  const raw = src?.title ?? "";
  const { body, tags } = splitTitle(raw);
  const tagLine = tags.join(" ");
  // 成片文案 = 正文标题 + 改写钩子(可选) + 话题
  const hook = rw?.hooks?.[0] ?? "";
  const caption = [body, hook && hook !== body ? hook : "", tagLine]
    .filter(Boolean)
    .join("\n\n");

  // 成片列表：从 artifacts 取 renders/<key>.mp4（多动效批量）；无则回退 final.mp4
  const renders = (detail.artifacts ?? [])
    .filter((a) => a.fileType === "mp4" && a.filePath.startsWith("renders/"))
    .map((a) => {
      const key = a.filePath.replace(/^renders\//, "").replace(/\.mp4$/, "");
      return { key, path: a.filePath, label: motionPreset(key).label };
    });
  const clips = renders.length > 0 ? renders : [{ key: "final", path: "final.mp4", label: "成片" }];
  const [sel, setSel] = useState(0);
  const active = clips[Math.min(sel, clips.length - 1)];

  const box: React.CSSProperties = {
    background: T.panelAlt,
    border: `1px solid ${T.border}`,
    borderRadius: 10,
    padding: "12px 14px",
    fontSize: 13,
    color: T.text,
    whiteSpace: "pre-wrap",
    lineHeight: 1.6,
  };
  const copyBtn = (key: string): React.CSSProperties => ({
    ...btn("ghost"),
    fontSize: 12,
    padding: "4px 12px",
    color: copied === key ? T.completed : T.textSoft,
    borderColor: copied === key ? T.completed : T.borderStrong,
  });

  return (
    <PanelShell
      title="⑨ 成片 + 发布"
      hint={done ? "成片已生成。下方发布文案可一键复制，直接粘到平台。" : "正在合成时间线并渲染成片…"}
      footer={
        <button onClick={rebuild} disabled={busy} style={btn("ghost")}>
          {busy ? "处理中…" : "重新合成"}
        </button>
      }
    >
      <div style={{ display: "flex", gap: 28, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* 左：成片预览（多动效画廊） */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {!done ? (
            <div
              style={{
                width: 300, height: 533, borderRadius: 14, background: "#000",
                border: `1px solid ${T.border}`, display: "flex",
                alignItems: "center", justifyContent: "center", color: T.textFaint, fontSize: 13,
              }}
            >
              {status === "failed" ? "渲染失败，点「重新合成」" : "渲染中…"}
            </div>
          ) : (
            <>
              {/* 动效切换标签 */}
              {clips.length > 1 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {clips.map((c, i) => {
                    const on = i === sel;
                    return (
                      <button
                        key={c.key}
                        onClick={() => setSel(i)}
                        style={{
                          fontSize: 12, padding: "5px 12px", borderRadius: 16,
                          border: `1.5px solid ${on ? T.accent : T.border}`,
                          background: on ? T.accent : T.panel,
                          color: on ? T.accentText : T.text, cursor: "pointer",
                        }}
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              )}
              <video
                key={active.path}
                src={`/api/tasks/${taskId}/file/${active.path}`}
                controls
                style={{ width: 300, borderRadius: 14, background: "#000", border: `1px solid ${T.border}` }}
              />
              <a
                href={`/api/tasks/${taskId}/file/${active.path}`}
                download
                style={{ ...btn("primary"), textDecoration: "none", display: "inline-block", textAlign: "center" }}
              >
                ↓ 下载{clips.length > 1 ? `「${active.label}」` : "成片"}
              </a>
              {clips.length > 1 && (
                <div style={{ fontSize: 12, color: T.textFaint, textAlign: "center" }}>
                  共 {clips.length} 条不同动效成片
                </div>
              )}
            </>
          )}
        </div>

        {/* 右：发布物料 */}
        <div style={{ flex: 1, minWidth: 320, display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>📋 发布文案（标题 + 话题）</span>
              <button onClick={() => copy("cap", caption)} style={copyBtn("cap")}>
                {copied === "cap" ? "✓ 已复制" : "复制全部"}
              </button>
            </div>
            <div style={box}>{caption || "（待抖音解析完成）"}</div>
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}># 话题标签</span>
              <button onClick={() => copy("tags", tagLine)} style={copyBtn("tags")} disabled={!tagLine}>
                {copied === "tags" ? "✓ 已复制" : "复制话题"}
              </button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {tags.length ? (
                tags.map((t) => (
                  <span
                    key={t}
                    style={{
                      fontSize: 12, color: T.accent, background: T.accentSoft,
                      padding: "4px 10px", borderRadius: 14,
                    }}
                  >
                    {t}
                  </span>
                ))
              ) : (
                <span style={{ color: T.textFaint, fontSize: 12 }}>原视频标题无话题标签</span>
              )}
            </div>
          </div>

          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 6 }}>📚 关联图书</div>
            <div style={{ ...box, padding: "8px 14px" }}>{rw?.sourceBook || "—"}</div>
          </div>
        </div>
      </div>
    </PanelShell>
  );
}

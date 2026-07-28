"use client";

import { useEffect, useRef, useState } from "react";
import { T, btn } from "../../../ui/theme";
import { advance, saveEdit, useArtifact, PanelShell, StepLoader, type PanelProps } from "./shared";

type Rewrite = { title: string; sourceBook: string; hooks: string[]; script: string };
type BookCover = {
  coverPath: string;
  originalName: string;
  width: number;
  height: number;
  updatedAt: number;
};

const field: React.CSSProperties = {
  background: T.panel, border: `1px solid ${T.border}`, borderRadius: 8,
  padding: "10px 12px", fontSize: 14, color: T.text, width: "100%",
  boxSizing: "border-box", fontFamily: "inherit",
};

/** ③改写稿 + 选书 — 编辑口播稿/书名/标题，确认后生成分镜（合并原④选书面板） */
export function RewritePanel({ taskId, detail, reload, navigate }: PanelProps) {
  const read = useArtifact();
  const [d, setD] = useState<Rewrite | null>(null);
  const [busy, setBusy] = useState(false);
  const [cover, setCover] = useState<BookCover | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const done = detail.steps.find((s) => s.name === "rewrite")?.status === "completed";
  const step = detail.steps.find((s) => s.name === "rewrite");

  useEffect(() => {
    if (!done) return;
    read<Rewrite>(taskId, "rewrite.json").then((x) => x && setD(x));
  }, [done, taskId, read]);

  useEffect(() => {
    if (!done) return;
    fetch(`/api/tasks/${taskId}/book-cover`)
      .then((r) => r.json())
      .then((r) => r.ok && setCover(r.cover ?? null))
      .catch(() => {});
  }, [done, taskId]);

  async function uploadCover(file: File) {
    if (!d) return;
    setCoverBusy(true);
    setCoverError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("sourceBook", d.sourceBook ?? "");
      const r = await fetch(`/api/tasks/${taskId}/book-cover`, {
        method: "POST",
        body: form,
      }).then((response) => response.json());
      if (!r.ok) throw new Error(r.error || "封面上传失败");
      setCover(r.cover);
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : "封面上传失败");
    } finally {
      setCoverBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function deleteCover() {
    if (!window.confirm("删除真实书籍封面并恢复原场景图？")) return;
    setCoverBusy(true);
    setCoverError("");
    try {
      const r = await fetch(`/api/tasks/${taskId}/book-cover`, {
        method: "DELETE",
      }).then((response) => response.json());
      if (!r.ok) throw new Error(r.error || "删除封面失败");
      setCover(null);
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : "删除封面失败");
    } finally {
      setCoverBusy(false);
    }
  }

  async function next() {
    if (!d) return;
    setBusy(true);
    try {
      const saved = await saveEdit(taskId, "rewrite", d); // 同时保存口播稿 + 书名/标题
      if (!saved) throw new Error("保存改写稿失败");
      const advanced = await advance(taskId, "storyboard"); // 正确：直接推进到分镜
      if (!advanced) throw new Error("生成分镜失败");
      reload();
      navigate("storyboard");
    } catch (error) {
      alert(error instanceof Error ? error.message : "进入分镜失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelShell
      title="③ 改写稿"
      hint="审阅口播稿、确认书名与标题，确认后生成分镜。"
      footer={
        <button onClick={next} disabled={busy || !d} style={btn("primary")}>
          {busy ? "处理中…" : "确认，生成分镜 →"}
        </button>
      }
    >
      {!done || !d ? (
        <StepLoader step={step} label="分析改写" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ color: T.textFaint, fontSize: 12 }}>书名（AI 反推，可修正）</label>
              <input
                value={d.sourceBook ?? ""}
                onChange={(e) => setD({ ...d, sourceBook: e.target.value })}
                placeholder="如《不生病的活法》"
                style={{ ...field, marginTop: 6 }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ color: T.textFaint, fontSize: 12 }}>视频标题</label>
              <input
                value={d.title}
                onChange={(e) => setD({ ...d, title: e.target.value })}
                style={{ ...field, marginTop: 6 }}
              />
            </div>
          </div>
          <div
            style={{
              border: `1px solid ${T.border}`,
              borderRadius: 10,
              padding: 14,
              background: T.panelAlt,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>
              真实书籍封面（可选）
            </div>
            <div style={{ fontSize: 12, color: T.textSoft, marginTop: 4 }}>
              用于已确认的推荐书籍分镜和视频结尾。上传、替换与重新应用均为本地合成，生图费用为 0。
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadCover(file);
              }}
              style={{ display: "none" }}
            />
            {cover ? (
              <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 12 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/tasks/${taskId}/file/${cover.coverPath}?v=${cover.updatedAt}`}
                  alt="真实书籍封面"
                  style={{
                    width: 92,
                    height: 112,
                    objectFit: "contain",
                    borderRadius: 7,
                    border: `1px solid ${T.border}`,
                    background: "#fff",
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    title={cover.originalName}
                    style={{ fontSize: 13, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {cover.originalName}
                  </div>
                  <div style={{ fontSize: 11, color: T.textFaint, marginTop: 4 }}>
                    {cover.width} × {cover.height} · 已保存原始封面内容
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button
                      onClick={() => fileInput.current?.click()}
                      disabled={coverBusy}
                      style={btn("ghost")}
                    >
                      {coverBusy ? "处理中…" : "替换封面"}
                    </button>
                    <button
                      onClick={deleteCover}
                      disabled={coverBusy}
                      style={{ ...btn("ghost"), color: T.failed }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <button
                onClick={() => fileInput.current?.click()}
                disabled={coverBusy}
                style={{ ...btn("ghost"), marginTop: 12 }}
              >
                {coverBusy ? "上传处理中…" : "上传真实封面"}
              </button>
            )}
            {coverError && (
              <div style={{ color: T.failed, fontSize: 12, marginTop: 8 }}>{coverError}</div>
            )}
          </div>
          <div>
            <label style={{ color: T.textFaint, fontSize: 12 }}>口播稿（喂 TTS / 分镜）</label>
            <textarea
              value={d.script}
              onChange={(e) => setD({ ...d, script: e.target.value })}
              style={{ ...field, marginTop: 6, minHeight: 280, resize: "vertical", lineHeight: 1.8 }}
            />
          </div>
          {d.hooks?.length > 0 && (
            <div style={{ color: T.textSoft, fontSize: 13 }}>钩子：{d.hooks.join(" / ")}</div>
          )}
        </div>
      )}
    </PanelShell>
  );
}

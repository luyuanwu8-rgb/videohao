"use client";

import { useEffect, useState } from "react";
import { T, btn } from "../../../ui/theme";
import { advance, saveEdit, useArtifact, PanelShell, StepLoader, type PanelProps } from "./shared";

type Scene = { id: number; text: string; visual: string; estDuration: number };
type Storyboard = { scenes: Scene[] };
type BookCover = { coverPath: string; originalName: string; updatedAt: number };
type BookPlacement = {
  autoCandidateSceneId: number | null;
  selectedSceneId: number | null;
  candidateReason: string;
  selectionMode: "auto" | "manual" | "ending-only";
  confirmed: boolean;
  showAtEnd: boolean;
};

/** ④分镜 — 逐镜头审/改文字与画面描述，并确认真实书籍推荐位置。 */
export function StoryboardPanel({ taskId, detail, reload, navigate }: PanelProps) {
  const read = useArtifact();
  const [d, setD] = useState<Storyboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [cover, setCover] = useState<BookCover | null>(null);
  const [placement, setPlacement] = useState<BookPlacement | null>(null);
  const [placementBusy, setPlacementBusy] = useState(false);
  const [placementError, setPlacementError] = useState("");

  const done = detail.steps.find((s) => s.name === "storyboard")?.status === "completed";
  const step = detail.steps.find((s) => s.name === "storyboard");

  useEffect(() => {
    if (!done) return;
    read<Storyboard>(taskId, "storyboard.json").then((x) => x && setD(x));
  }, [done, taskId, read]);

  useEffect(() => {
    if (!done) return;
    fetch(`/api/tasks/${taskId}/book-cover`)
      .then((r) => r.json())
      .then((r) => {
        if (!r.ok) return;
        setCover(r.cover ?? null);
        setPlacement(r.showcase ?? null);
      })
      .catch(() => {});
  }, [done, taskId]);

  function update(i: number, key: "text" | "visual", v: string) {
    if (!d) return;
    const scene = d.scenes[i];
    setD({ scenes: d.scenes.map((s, idx) => (idx === i ? { ...s, [key]: v } : s)) });
    if (key === "text" && placement?.selectedSceneId === scene.id) {
      setPlacement({ ...placement, confirmed: false });
    }
  }

  function chooseRecommendation(sceneId: number | null) {
    if (!placement) return;
    setPlacement({
      ...placement,
      selectedSceneId: sceneId,
      selectionMode:
        sceneId === null
          ? "ending-only"
          : sceneId === placement.autoCandidateSceneId
            ? "auto"
            : "manual",
      confirmed: false,
    });
    setPlacementError("");
  }

  async function persistPlacement() {
    if (!placement) return null;
    setPlacementBusy(true);
    setPlacementError("");
    try {
      const r = await fetch(`/api/tasks/${taskId}/book-cover`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedSceneId: placement.selectedSceneId,
          showAtEnd: placement.showAtEnd,
        }),
      }).then((response) => response.json());
      if (!r.ok) throw new Error(r.error || "保存书籍展示位置失败");
      setPlacement(r.showcase);
      return r.showcase as BookPlacement;
    } catch (error) {
      setPlacementError(error instanceof Error ? error.message : "保存书籍展示位置失败");
      return null;
    } finally {
      setPlacementBusy(false);
    }
  }

  async function next() {
    if (!d) return;
    if (cover && placement && !placement.confirmed) {
      setPlacementError("请先确认推荐书籍展示位置，或选择“仅在结尾展示”");
      return;
    }
    setBusy(true);
    try {
      const saved = await saveEdit(taskId, "storyboard", d);
      if (!saved) throw new Error("保存分镜失败");
      if (cover && placement) {
        const confirmed = await persistPlacement();
        if (!confirmed) return;
      }
      const advanced = await advance(taskId, "director");
      if (!advanced) throw new Error("生成导演分镜失败");
      reload();
      navigate("director");
    } catch (error) {
      alert(error instanceof Error ? error.message : "进入导演分镜失败");
    } finally {
      setBusy(false);
    }
  }

  const field: React.CSSProperties = {
    background: T.panel, border: `1px solid ${T.border}`, borderRadius: 6,
    padding: "7px 10px", fontSize: 13, color: T.text, width: "100%",
    boxSizing: "border-box", fontFamily: "inherit", resize: "vertical",
  };

  return (
    <PanelShell
      title="④ 分镜"
      hint="逐条审阅口播与画面；上传真实封面后，在这里确认推荐书籍的展示位置。"
      footer={
        <button onClick={next} disabled={busy || !d} style={btn("primary")}>
          {busy ? "处理中…" : "确认分镜，AI 导演规划 →"}
        </button>
      }
    >
      {!done || !d ? (
        <StepLoader step={step} label="切分镜头" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {cover && placement && (
            <div
              style={{
                border: `2px solid ${placement.confirmed ? T.completed : T.accent}`,
                borderRadius: 10,
                padding: 14,
                background: T.panelAlt,
                marginBottom: 4,
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/tasks/${taskId}/file/${cover.coverPath}?v=${cover.updatedAt}`}
                  alt=""
                  style={{ width: 58, height: 72, objectFit: "contain", background: "#fff", borderRadius: 5 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: T.text, fontSize: 14 }}>
                    真实书籍展示位置
                  </div>
                  <div style={{ color: T.textSoft, fontSize: 12, marginTop: 4 }}>
                    {placement.candidateReason}
                  </div>
                  <div style={{ color: T.text, fontSize: 12, marginTop: 6 }}>
                    当前推荐段：
                    {placement.selectedSceneId
                      ? `第 ${placement.selectedSceneId} 分镜`
                      : "仅在结尾展示"}
                    {placement.confirmed && (
                      <span style={{ color: T.completed, marginLeft: 8 }}>✓ 已确认</span>
                    )}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
                <button
                  onClick={() => chooseRecommendation(null)}
                  style={btn(placement.selectedSceneId === null ? "primary" : "ghost")}
                >
                  仅在结尾展示
                </button>
                <label style={{ display: "flex", gap: 6, alignItems: "center", color: T.textSoft, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={placement.showAtEnd}
                    onChange={(e) =>
                      setPlacement({ ...placement, showAtEnd: e.target.checked, confirmed: false })
                    }
                  />
                  结尾展示真实封面
                </label>
                <button
                  onClick={() => void persistPlacement()}
                  disabled={placementBusy}
                  style={btn("primary")}
                >
                  {placementBusy ? "保存中…" : "确认展示位置"}
                </button>
              </div>
              {placementError && (
                <div style={{ color: T.failed, fontSize: 12, marginTop: 8 }}>{placementError}</div>
              )}
            </div>
          )}
          {d.scenes.map((s, i) => (
            <div
              key={s.id}
              style={{
                background: T.panelAlt,
                border: `2px solid ${
                  cover && placement?.selectedSceneId === s.id ? T.accent : T.border
                }`,
                borderRadius: 10,
                padding: 12,
                display: "flex",
                gap: 12,
              }}
            >
              <span style={{ color: T.textFaint, fontSize: 13, fontWeight: 700, minWidth: 22 }}>{s.id}</span>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                {cover && placement && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button
                      onClick={() => chooseRecommendation(s.id)}
                      style={{
                        borderRadius: 6,
                        border: `1px solid ${
                          placement.selectedSceneId === s.id ? T.accent : T.border
                        }`,
                        background:
                          placement.selectedSceneId === s.id ? T.accentSoft : T.panel,
                        color: placement.selectedSceneId === s.id ? T.accent : T.textSoft,
                        padding: "4px 8px",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      {placement.selectedSceneId === s.id
                        ? "✓ 推荐书籍展示"
                        : "设为推荐书籍展示"}
                    </button>
                    {placement.autoCandidateSceneId === s.id && (
                      <span style={{ color: T.accent, fontSize: 11 }}>系统推荐候选</span>
                    )}
                  </div>
                )}
                <textarea value={s.text} onChange={(e) => update(i, "text", e.target.value)} rows={2} style={field} />
                <textarea value={s.visual} onChange={(e) => update(i, "visual", e.target.value)} rows={2} style={{ ...field, color: T.textSoft, fontStyle: "italic" }} placeholder="画面描述" />
              </div>
            </div>
          ))}
        </div>
      )}
    </PanelShell>
  );
}

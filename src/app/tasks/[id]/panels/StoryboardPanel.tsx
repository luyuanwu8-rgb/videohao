"use client";

import { useEffect, useState } from "react";
import { T, btn } from "../../../ui/theme";
import { advance, saveEdit, useArtifact, PanelShell, StepLoader, type PanelProps } from "./shared";

type Scene = { id: number; text: string; visual: string; estDuration: number };
type Storyboard = { scenes: Scene[] };

/** ⑤分镜 — 逐镜头审/改 文字+画面描述（画面风格已移至⑦场景图） */
export function StoryboardPanel({ taskId, detail, reload, navigate }: PanelProps) {
  const read = useArtifact();
  const [d, setD] = useState<Storyboard | null>(null);
  const [busy, setBusy] = useState(false);

  const done = detail.steps.find((s) => s.name === "storyboard")?.status === "completed";
  const step = detail.steps.find((s) => s.name === "storyboard");

  useEffect(() => {
    if (!done) return;
    read<Storyboard>(taskId, "storyboard.json").then((x) => x && setD(x));
  }, [done, taskId, read]);

  function update(i: number, key: "text" | "visual", v: string) {
    if (!d) return;
    setD({ scenes: d.scenes.map((s, idx) => (idx === i ? { ...s, [key]: v } : s)) });
  }

  async function next() {
    if (!d) return;
    setBusy(true);
    await saveEdit(taskId, "storyboard", d);
    await advance(taskId, "director");
    reload();
    navigate("director");
    setBusy(false);
  }

  const field: React.CSSProperties = {
    background: T.panel, border: `1px solid ${T.border}`, borderRadius: 6,
    padding: "7px 10px", fontSize: 13, color: T.text, width: "100%",
    boxSizing: "border-box", fontFamily: "inherit", resize: "vertical",
  };

  return (
    <PanelShell
      title="⑤ 分镜"
      hint="每个镜头一句口播 + 一句画面描述。可逐条修改，确认后生成配音与场景图。"
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
          {d.scenes.map((s, i) => (
            <div key={s.id} style={{ background: T.panelAlt, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, display: "flex", gap: 12 }}>
              <span style={{ color: T.textFaint, fontSize: 13, fontWeight: 700, minWidth: 22 }}>{s.id}</span>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
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

"use client";

import { useEffect, useState } from "react";
import { T, btn } from "../../../ui/theme";
import { advance, saveEdit, useArtifact, PanelShell, StepLoader, type PanelProps } from "./shared";

type Rewrite = { title: string; sourceBook: string; hooks: string[]; script: string };

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

  const done = detail.steps.find((s) => s.name === "rewrite")?.status === "completed";
  const step = detail.steps.find((s) => s.name === "rewrite");

  useEffect(() => {
    if (!done) return;
    read<Rewrite>(taskId, "rewrite.json").then((x) => x && setD(x));
  }, [done, taskId, read]);

  async function next() {
    if (!d) return;
    setBusy(true);
    await saveEdit(taskId, "rewrite", d); // 同时保存口播稿 + 书名/标题
    await advance(taskId, "storyboard");  // 正确：直接推进到分镜
    reload();
    navigate("storyboard");
    setBusy(false);
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

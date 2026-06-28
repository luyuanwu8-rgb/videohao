"use client";

import { useEffect, useState } from "react";
import { T, btn } from "../../../ui/theme";
import {
  advance,
  saveEdit,
  useArtifact,
  PanelShell,
  StepLoader,
  type PanelProps,
} from "./shared";

type Transcript = { text: string; words?: unknown[]; language?: string };

/** ②逐字稿校对 — 可编辑全文,保存后下游(改写起)失效需重跑 */
export function TranscriptPanel({ taskId, detail, reload, navigate }: PanelProps) {
  const read = useArtifact();
  const [data, setData] = useState<Transcript | null>(null);
  const [text, setText] = useState("");
  const [orig, setOrig] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const done =
    detail.steps.find((s) => s.name === "transcribe")?.status === "completed";
  const step = detail.steps.find((s) => s.name === "transcribe");

  useEffect(() => {
    if (!done) return;
    read<Transcript>(taskId, "transcript.json").then((d) => {
      if (d) {
        setData(d);
        setText(d.text);
        setOrig(d.text);
      }
    });
  }, [done, taskId, read]);

  async function save() {
    if (!data) return;
    setBusy(true);
    await saveEdit(taskId, "transcript", { ...data, text });
    setOrig(text);
    setSaved(true);
    setBusy(false);
    reload();
  }

  async function next() {
    setBusy(true);
    if (text !== orig) await saveEdit(taskId, "transcript", { ...data, text });
    await advance(taskId, "rewrite");
    reload();
    navigate("rewrite");
    setBusy(false);
  }

  const dirty = text !== orig;

  return (
    <PanelShell
      title="② 逐字稿校对"
      hint="校对识别出的逐字稿，修正错别字、标点、专有名词。改动会让后续改写重新生成。"
      footer={
        <>
          {dirty && (
            <button onClick={save} disabled={busy} style={btn("ghost")}>
              {busy ? "保存中…" : "保存修改"}
            </button>
          )}
          <button onClick={next} disabled={busy || !done} style={btn("primary")}>
            {busy ? "处理中…" : "确认，生成改写稿 →"}
          </button>
        </>
      }
    >
      {!done ? (
        <StepLoader step={step} label="转写逐字稿" />
      ) : (
        <div style={{ display: "flex", gap: 16, height: "100%" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <label style={{ color: T.textFaint, fontSize: 12, marginBottom: 6 }}>
              识别原文（只读）
            </label>
            <div
              style={{
                flex: 1,
                background: T.panelAlt,
                border: `1px solid ${T.border}`,
                borderRadius: 8,
                padding: 14,
                fontSize: 14,
                lineHeight: 1.8,
                color: T.textSoft,
                overflowY: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {orig}
            </div>
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <label style={{ color: T.textFaint, fontSize: 12, marginBottom: 6 }}>
              校对稿（可编辑）
            </label>
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setSaved(false);
              }}
              style={{
                flex: 1,
                background: T.panel,
                border: `1px solid ${dirty ? T.accent : T.border}`,
                borderRadius: 8,
                padding: 14,
                fontSize: 14,
                lineHeight: 1.8,
                color: T.text,
                resize: "none",
                fontFamily: "inherit",
              }}
            />
            {saved && (
              <span style={{ color: T.completed, fontSize: 12, marginTop: 6 }}>
                ✓ 已保存
              </span>
            )}
          </div>
        </div>
      )}
    </PanelShell>
  );
}

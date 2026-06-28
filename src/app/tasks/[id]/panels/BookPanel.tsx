"use client";

import { useEffect, useState } from "react";
import { T, btn } from "../../../ui/theme";
import {
  advance,
  saveEdit,
  useArtifact,
  PanelShell,
  type PanelProps,
} from "./shared";

type Rewrite = {
  title: string;
  sourceBook: string;
  hooks: string[];
  script: string;
};

/** ④选书+标题 — 确认 AI 反推的书名,可改长/短标题(纯配置点,复用 rewrite.json) */
export function BookPanel({ taskId, detail, reload, navigate }: PanelProps) {
  const read = useArtifact();
  const [d, setD] = useState<Rewrite | null>(null);
  const [shortTitle, setShortTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const done =
    detail.steps.find((s) => s.name === "rewrite")?.status === "completed";

  useEffect(() => {
    if (!done) return;
    read<Rewrite>(taskId, "rewrite.json").then((x) => {
      if (x) {
        setD(x);
        setShortTitle(x.title.length > 14 ? x.title.slice(0, 14) : x.title);
      }
    });
  }, [done, taskId, read]);

  async function save() {
    if (!d) return;
    setBusy(true);
    await saveEdit(taskId, "book", d);
    setSaved(true);
    setBusy(false);
    reload();
  }

  async function next() {
    if (!d) return;
    setBusy(true);
    await saveEdit(taskId, "book", d);
    setActiveDone();
    setBusy(false);
  }
  function setActiveDone() {
    reload();
    navigate("storyboard");
  }

  const field: React.CSSProperties = {
    background: T.panel,
    border: `1px solid ${T.border}`,
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    color: T.text,
    width: "100%",
    boxSizing: "border-box",
    fontFamily: "inherit",
  };

  return (
    <PanelShell
      title="④ 选书 + 标题"
      hint="确认这条视频对应的图书。书名会用于成片水印与标题，务必核对准确。"
      footer={
        <button onClick={save} disabled={busy || !d} style={btn("primary")}>
          {busy ? "保存中…" : saved ? "✓ 已确认" : "确认书名与标题"}
        </button>
      }
    >
      {!done || !d ? (
        <p style={{ color: T.textSoft }}>等待改写稿生成后反推书名…</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 560 }}>
          <div>
            <label style={{ color: T.textFaint, fontSize: 12 }}>
              书名（AI 反推，可修正）
            </label>
            <input
              value={d.sourceBook}
              onChange={(e) => {
                setD({ ...d, sourceBook: e.target.value });
                setSaved(false);
              }}
              placeholder="如《不生病的活法》"
              style={{ ...field, marginTop: 6 }}
            />
          </div>
          <div>
            <label style={{ color: T.textFaint, fontSize: 12 }}>
              长标题（视频标题）
            </label>
            <input
              value={d.title}
              onChange={(e) => {
                setD({ ...d, title: e.target.value });
                setSaved(false);
              }}
              style={{ ...field, marginTop: 6 }}
            />
          </div>
          <div>
            <label style={{ color: T.textFaint, fontSize: 12 }}>
              短标题（封面用，≤14 字）
            </label>
            <input
              value={shortTitle}
              onChange={(e) => setShortTitle(e.target.value.slice(0, 14))}
              style={{ ...field, marginTop: 6 }}
            />
          </div>
          <p style={{ color: T.textFaint, fontSize: 12 }}>
            确认后请到左侧「分镜」继续。
          </p>
        </div>
      )}
    </PanelShell>
  );
}

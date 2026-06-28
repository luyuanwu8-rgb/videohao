"use client";

import { useEffect, useState } from "react";
import { T, btn } from "../../../ui/theme";
import { saveEdit, useArtifact, PanelShell, StepLoader, type PanelProps } from "./shared";

type Cast = { id: string; bible: string };
type Beat = { id: number; sceneIds: number[]; use: string; shotType: string; mood: string; composition: string };
type Director = {
  audience: string; theme: string; emotionArc: string; visualTone: string;
  cast: Cast[]; beats: Beat[];
};

/** 导演分镜 — 编辑受众/母题/视觉基调/角色卡/逐拍画面设计，确认后生成配音+场景图 */
export function DirectorPanel({ taskId, detail, reload, navigate }: PanelProps) {
  const read = useArtifact();
  const [d, setD] = useState<Director | null>(null);
  const [busy, setBusy] = useState(false);

  const done = detail.steps.find((s) => s.name === "director")?.status === "completed";
  const step = detail.steps.find((s) => s.name === "director");

  useEffect(() => {
    if (!done) return;
    read<Director>(taskId, "director.json").then((x) => x && setD(x));
  }, [done, taskId, read]);

  function setField<K extends keyof Director>(k: K, v: Director[K]) {
    setD((cur) => (cur ? { ...cur, [k]: v } : cur));
  }
  function setBeat(i: number, k: keyof Beat, v: string) {
    setD((cur) => {
      if (!cur) return cur;
      const beats = cur.beats.map((b, idx) => (idx === i ? { ...b, [k]: v } : b));
      return { ...cur, beats };
    });
  }
  function setCast(i: number, k: keyof Cast, v: string) {
    setD((cur) => {
      if (!cur) return cur;
      const cast = cur.cast.map((c, idx) => (idx === i ? { ...c, [k]: v } : c));
      return { ...cur, cast };
    });
  }

  async function next() {
    if (!d) return;
    setBusy(true);
    await saveEdit(taskId, "director", d); // 写 director.json + 重置 imageGenerate
    reload();
    navigate("tts"); // 只导航到配音，配音/生图由各自面板选好参数后手动触发
    setBusy(false);
  }

  const field: React.CSSProperties = {
    background: T.panel, border: `1px solid ${T.border}`, borderRadius: 6,
    padding: "7px 10px", fontSize: 13, color: T.text, width: "100%",
    boxSizing: "border-box", fontFamily: "inherit", resize: "vertical",
  };
  const label: React.CSSProperties = { color: T.textFaint, fontSize: 12, marginBottom: 4, display: "block" };

  return (
    <PanelShell
      title="导演分镜"
      hint="导演已通读全文，规划好受众、母题、视觉基调与逐拍画面。可逐项修改，确认后生成配音与场景图（每拍出一张图）。"
      footer={
        <button onClick={next} disabled={busy || !d} style={btn("primary")}>
          {busy ? "处理中…" : "确认导演方案 →"}
        </button>
      }
    >
      {!done || !d ? (
        <StepLoader step={step} label="导演规划画面" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* 全局设定 */}
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={label}>目标受众（改这里，角色/画面会跟着变）</label>
              <input value={d.audience} onChange={(e) => setField("audience", e.target.value)} style={field} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>母题</label>
              <input value={d.theme} onChange={(e) => setField("theme", e.target.value)} style={field} />
            </div>
          </div>
          <div>
            <label style={label}>情绪曲线</label>
            <input value={d.emotionArc} onChange={(e) => setField("emotionArc", e.target.value)} style={field} />
          </div>
          <div>
            <label style={label}>全局视觉基调（写实度/色调/审美，所有图统一遵守）</label>
            <textarea value={d.visualTone} onChange={(e) => setField("visualTone", e.target.value)} rows={2} style={field} />
          </div>

          {/* 角色卡 */}
          <div>
            <label style={label}>角色卡（反复出现的人物，保证一致）</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {d.cast.map((c, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input value={c.id} onChange={(e) => setCast(i, "id", e.target.value)} style={{ ...field, width: 60 }} />
                  <input value={c.bible} onChange={(e) => setCast(i, "bible", e.target.value)} style={field} />
                </div>
              ))}
              {d.cast.length === 0 && <span style={{ color: T.textFaint, fontSize: 12 }}>（本片以空镜为主，无固定角色）</span>}
            </div>
          </div>

          {/* 逐拍画面 */}
          <div>
            <label style={label}>画面节拍（{d.beats.length} 拍 → 出 {d.beats.length} 张图，每拍覆盖若干句）</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {d.beats.map((b, i) => (
                <div key={b.id} style={{ background: T.panelAlt, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, display: "flex", gap: 12 }}>
                  <span style={{ color: T.textFaint, fontSize: 13, fontWeight: 700, minWidth: 22 }}>{b.id}</span>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", gap: 8, fontSize: 12, color: T.textSoft }}>
                      <span>覆盖句: {b.sceneIds.join(",")}</span>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input value={b.use} onChange={(e) => setBeat(i, "use", e.target.value)} placeholder="cast:A / 空镜 / 配角" style={{ ...field, width: 130 }} />
                      <input value={b.shotType} onChange={(e) => setBeat(i, "shotType", e.target.value)} placeholder="景别" style={{ ...field, width: 90 }} />
                      <input value={b.mood} onChange={(e) => setBeat(i, "mood", e.target.value)} placeholder="情绪" style={{ ...field, width: 90 }} />
                    </div>
                    <textarea value={b.composition} onChange={(e) => setBeat(i, "composition", e.target.value)} rows={2} placeholder="构图+光线+场景（出图核心描述）" style={field} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </PanelShell>
  );
}

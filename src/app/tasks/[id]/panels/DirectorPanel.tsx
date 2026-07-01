"use client";

import { useEffect, useRef, useState } from "react";
import { T, btn } from "../../../ui/theme";
import { saveEdit, saveConfig, useArtifact, PanelShell, StepLoader, type PanelProps } from "./shared";

type Cast = { id: string; bible: string };
type Beat = { id: number; sceneIds: number[]; use: string; shotType: string; mood: string; composition: string };
type Director = {
  audience: string; theme: string; emotionArc: string; visualTone: string;
  cast: Cast[]; beats: Beat[];
};
type CastConfig = { locked: boolean; cast: Cast[] };

/** 导演分镜 — 编辑受众/母题/视觉基调/角色卡/逐拍画面设计，确认后生成配音+场景图 */
export function DirectorPanel({ taskId, detail, reload, navigate }: PanelProps) {
  const read = useArtifact();
  const [d, setD] = useState<Director | null>(null);
  const [busy, setBusy] = useState(false);
  // 用户锁定人物(独立于 director.json，重跑导演不被覆盖)
  const [castCfg, setCastCfg] = useState<CastConfig>({ locked: false, cast: [] });

  const done = detail.steps.find((s) => s.name === "director")?.status === "completed";
  const step = detail.steps.find((s) => s.name === "director");

  useEffect(() => {
    if (!done) return;
    read<Director>(taskId, "director.json").then((x) => x && setD(x));
  }, [done, taskId, read]);

  // 读已保存的锁定人物配置（不依赖 director 完成）
  useEffect(() => {
    read<CastConfig>(taskId, "cast-config.json").then((x) => x && setCastCfg(x));
  }, [taskId, read]);

  // castCfg 变化立即软保存到 cast-config.json（不触发重跑）
  const firstMount = useRef(true);
  useEffect(() => {
    if (firstMount.current) { firstMount.current = false; return; }
    saveConfig(taskId, "cast-config.json", castCfg);
  }, [taskId, castCfg]);

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
  // 锁定人物编辑
  function setLockCast(i: number, k: keyof Cast, v: string) {
    setCastCfg((c) => ({ ...c, cast: c.cast.map((x, idx) => (idx === i ? { ...x, [k]: v } : x)) }));
  }
  function addLockCast() {
    setCastCfg((c) => ({ ...c, cast: [...c.cast, { id: c.cast.length ? `role${c.cast.length + 1}` : "main", bible: "" }] }));
  }
  function removeLockCast(i: number) {
    setCastCfg((c) => ({ ...c, cast: c.cast.filter((_, idx) => idx !== i) }));
  }

  async function next() {
    if (!d) return;
    setBusy(true);
    await saveEdit(taskId, "director", d); // 写 director.json + 重置 imageGenerate
    reload();
    navigate("tts"); // 只导航到配音，配音/生图由各自面板选好参数后手动触发
    setBusy(false);
  }

  // 用当前锁定人物重新规划导演方案（保存 cast-config 后重跑 director）
  async function replanWithLockedCast() {
    setBusy(true);
    await saveConfig(taskId, "cast-config.json", castCfg);
    // /run 重跑 director：先把 director+下游重置 pending，再按 cast-config 锁定人物重规划
    await fetch(`/api/tasks/${taskId}/run`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "director" }),
    });
    reload();
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

          {/* 锁定人物（用户自定义，重跑不被导演覆盖） */}
          <div style={{ background: T.panelAlt, border: `1px solid ${castCfg.locked ? T.accent : T.border}`, borderRadius: 10, padding: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: castCfg.locked ? 10 : 0 }}>
              <input type="checkbox" checked={castCfg.locked}
                onChange={(e) => setCastCfg((c) => ({ ...c, cast: e.target.checked && c.cast.length === 0 ? [{ id: "main", bible: "" }] : c.cast, locked: e.target.checked }))} />
              <span style={{ fontWeight: 600, color: T.text, fontSize: 13 }}>🔒 锁定人物形象</span>
              <span style={{ color: T.textSoft, fontSize: 12 }}>勾选后由你定义主角，导演不再自创、重跑也不覆盖</span>
            </label>
            {castCfg.locked && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {castCfg.cast.map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input value={c.id} onChange={(e) => setLockCast(i, "id", e.target.value)} placeholder="标识" style={{ ...field, width: 70 }} />
                    <input value={c.bible} onChange={(e) => setLockCast(i, "bible", e.target.value)} placeholder="如：65岁中国老年女性，银发，慈祥，深色对襟开衫" style={field} />
                    <button onClick={() => removeLockCast(i)} style={{ ...btn("ghost"), padding: "4px 10px", color: T.failed }}>删</button>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button onClick={addLockCast} style={btn("ghost")}>+ 加人物</button>
                  <button onClick={replanWithLockedCast} disabled={busy} style={btn("primary")}>
                    {busy ? "重新规划中…" : "用锁定人物重新规划画面"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 角色卡（导演实际使用的，锁定时即上面定义的人物） */}
          <div>
            <label style={label}>角色卡（导演实际采用，反复出现保证一致）</label>
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

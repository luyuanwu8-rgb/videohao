"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { T, btn, cardStyle } from "../ui/theme";
import { VOLC_VOICES } from "@/lib/providers/voices";
import { IMAGE_STYLES, DEFAULT_STYLE } from "@/lib/styles";
import { MOTION_PRESETS, DEFAULT_MOTION } from "@/lib/motions";

/** 快速制作配置中心:一页预设全部配置 → 自动跑到审阅点(或全自动到成片)。建立在阶段0地基之上。 */
export default function QuickCreate() {
  const router = useRouter();
  const [mode, setMode] = useState<"link" | "script">("script");
  const [url, setUrl] = useState("");
  const [script, setScript] = useState("");
  const [track, setTrack] = useState("health");
  const [voice, setVoice] = useState(VOLC_VOICES[0].id);
  const [speed, setSpeed] = useState(1.0);
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [ratio, setRatio] = useState("9:16");
  const [motions, setMotions] = useState<string[]>([DEFAULT_MOTION]);
  const [disclaimer, setDisclaimer] = useState("本视频内容仅供参考，不构成医疗建议");
  const [imageSeconds, setImageSeconds] = useState(4.5);
  const [stopAt, setStopAt] = useState("director"); // 审阅点:director/image/final
  const [busy, setBusy] = useState(false);

  const inp: React.CSSProperties = {
    padding: "9px 12px", background: T.panel, border: `1px solid ${T.border}`,
    borderRadius: 8, color: T.text, fontSize: 14,
  };
  const label: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 6, display: "block" };
  const row: React.CSSProperties = { marginBottom: 18 };

  function toggleMotion(k: string) {
    setMotions((m) => {
      const has = m.includes(k);
      const next = has ? m.filter((x) => x !== k) : [...m, k];
      return next.length ? next : [k];
    });
  }

  async function submit() {
    if (mode === "script" ? !script.trim() : !url.trim()) return;
    setBusy(true);
    try {
      const presets = {
        voiceConfig: { provider: "volcengine", voice, speed },
        imageConfig: { style, ratio },
        renderConfig: { motions, disclaimer, imageSeconds },
        // 人物/国籍由导演自动从文案提取,不在此手填(如需锁定,在「导演分镜」面板操作)
      };
      const body = {
        ...(mode === "script" ? { script: script.trim() } : { sourceUrl: url.trim() }),
        track,
        presets,
        autoRun: { stopAt },
      };
      const r = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (r.ok && r.taskId) router.push(`/tasks/${r.taskId}`);
      else alert(r.error || "创建失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "36px 24px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, margin: 0, color: T.text }}>⚡ 快速制作</h1>
        <Link href="/" style={{ color: T.accent, fontSize: 13, textDecoration: "none" }}>← 返回任务列表</Link>
      </header>
      <p style={{ color: T.textSoft, fontSize: 13, marginBottom: 20 }}>
        一次配置好所有选项,创建后后台自动跑到审阅点(或全自动到成片)。<b>人物国籍/场景由导演自动从文案提取</b>,无需手填(如需锁定可在「导演分镜」面板调整)。
      </p>

      <div style={cardStyle}>
        {/* 来源 */}
        <div style={row}>
          <span style={label}>来源</span>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            {([["script", "自带文案"], ["link", "抖音链接"]] as const).map(([m, t]) => (
              <button key={m} onClick={() => setMode(m)} style={{
                padding: "6px 16px", borderRadius: 7, fontSize: 13, cursor: "pointer",
                border: `1.5px solid ${mode === m ? T.accent : T.border}`,
                background: mode === m ? T.accent : T.panel, color: mode === m ? T.accentText : T.text,
              }}>{t}</button>
            ))}
            <select value={track} onChange={(e) => setTrack(e.target.value)} style={{ ...inp, marginLeft: "auto" }}>
              <option value="health">养生</option>
              <option value="emotion">情感</option>
              <option value="parenting">亲子</option>
            </select>
          </div>
          {mode === "script" ? (
            <textarea value={script} onChange={(e) => setScript(e.target.value)}
              placeholder="粘贴口播文案(将自动切分镜→导演→生图→配音→成片)…"
              style={{ ...inp, width: "100%", minHeight: 110, resize: "vertical", lineHeight: 1.7 }} />
          ) : (
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="粘贴抖音分享链接…" style={{ ...inp, width: "100%" }} />
          )}
        </div>

        {/* 配音 */}
        <div style={{ ...row, display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <span style={label}>配音音色</span>
            <select value={voice} onChange={(e) => setVoice(e.target.value)} style={{ ...inp, width: "100%" }}>
              {VOLC_VOICES.map((v) => <option key={v.id} value={v.id}>{v.name}（{v.group}）</option>)}
            </select>
          </div>
          <div style={{ width: 140 }}>
            <span style={label}>语速 {speed.toFixed(1)}</span>
            <input type="range" min={0.5} max={2} step={0.1} value={speed} onChange={(e) => setSpeed(+e.target.value)} style={{ width: "100%" }} />
          </div>
        </div>

        {/* 画面 */}
        <div style={{ ...row, display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <span style={label}>画面风格</span>
            <select value={style} onChange={(e) => setStyle(e.target.value)} style={{ ...inp, width: "100%" }}>
              {IMAGE_STYLES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
          <div style={{ width: 120 }}>
            <span style={label}>比例</span>
            <select value={ratio} onChange={(e) => setRatio(e.target.value)} style={{ ...inp, width: "100%" }}>
              {["9:16", "3:4", "1:1", "4:3", "16:9"].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div style={{ width: 150 }}>
            <span style={label}>画面节奏 {imageSeconds}s/张</span>
            <select value={imageSeconds} onChange={(e) => setImageSeconds(+e.target.value)} style={{ ...inp, width: "100%" }}>
              <option value={3}>紧凑 ~3s(图多)</option>
              <option value={4.5}>标准 ~4.5s</option>
              <option value={6.5}>舒缓 ~6.5s(省)</option>
            </select>
          </div>
        </div>

        {/* 运镜 + 声明 */}
        <div style={row}>
          <span style={label}>成片动效(可多选,每个多出一条成片)</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            {MOTION_PRESETS.map((m) => {
              const on = motions.includes(m.key);
              return (
                <button key={m.key} onClick={() => toggleMotion(m.key)} style={{
                  padding: "6px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer",
                  border: `1.5px solid ${on ? T.accent : T.border}`,
                  background: on ? T.accentSoft : T.panel, color: T.text,
                }}>{on ? "✓ " : ""}{m.label}</button>
              );
            })}
          </div>
          <input value={disclaimer} onChange={(e) => setDisclaimer(e.target.value)} placeholder="片尾声明(可留空)" style={{ ...inp, width: "100%" }} />
        </div>

        {/* 自动化策略 */}
        <div style={row}>
          <span style={label}>自动化策略</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {([
              ["director", "跑到「导演分镜」停下等我审一眼(推荐,防国籍/内容翻车)"],
              ["image", "跑到「场景图」停(先看图再继续)"],
              ["final", "全自动直接跑到成片(信任内容/走量)"],
            ] as const).map(([k, t]) => (
              <label key={k} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: T.text, cursor: "pointer" }}>
                <input type="radio" checked={stopAt === k} onChange={() => setStopAt(k)} />{t}
              </label>
            ))}
          </div>
        </div>

        <button onClick={submit} disabled={busy} style={{ ...btn("primary"), width: "100%", padding: "12px" }}>
          {busy ? "创建中…" : "🚀 开始自动制作"}
        </button>
      </div>
    </main>
  );
}

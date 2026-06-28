"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { T, btn } from "../../../ui/theme";
import { advance, saveEdit, saveConfig, useArtifact, PanelShell, StepLoader, type PanelProps } from "./shared";
import { VOLC_VOICES, STEPFUN_VOICES, defaultVoiceOf, type TtsProvider } from "@/lib/providers/voices";

type Seg = { sceneId: number; audioPath: string; duration: number };
type Voice = { segments: Seg[]; totalDuration: number };
type Config = { provider: TtsProvider; voice: string; speed: number };

const PROVIDERS: { key: TtsProvider; label: string; desc: string }[] = [
  { key: "volcengine", label: "火山引擎", desc: "157 角色化音色，最丰富" },
  { key: "stepfun", label: "StepFun", desc: "通用音色，稳定" },
];

/** ⑥配音 — 选 provider/音色/语速 + 试听 + 逐段播放 + 重新生成 */
export function TtsPanel({ taskId, detail, reload, navigate }: PanelProps) {
  const read = useArtifact();
  const [d, setD] = useState<Voice | null>(null);
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState<Config>({
    provider: "volcengine",
    voice: defaultVoiceOf("volcengine"),
    speed: 1.0,
  });
  const [query, setQuery] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const status = detail.steps.find((s) => s.name === "tts")?.status;
  const done = status === "completed";
  const step = detail.steps.find((s) => s.name === "tts");

  useEffect(() => {
    read<Config>(taskId, "voice-config.json").then((x) => x && setCfg((c) => ({ ...c, ...x })));
  }, [taskId, read]);

  // 每次 cfg 变化立即软保存到磁盘，不重置步骤——保证刷新后选择不丢失
  const isFirstMount = useRef(true);
  useEffect(() => {
    if (isFirstMount.current) { isFirstMount.current = false; return; }
    saveConfig(taskId, "voice-config.json", cfg);
  }, [taskId, cfg]);
  useEffect(() => {
    if (!done) return;
    read<Voice>(taskId, "voice.json").then((x) => x && setD(x));
  }, [done, taskId, read]);

  const voices = cfg.provider === "volcengine" ? VOLC_VOICES : STEPFUN_VOICES;
  const groups = useMemo(() => {
    const q = query.trim();
    const filtered = q ? voices.filter((v) => v.name.includes(q)) : voices;
    const m = new Map<string, typeof voices>();
    for (const v of filtered) {
      if (!m.has(v.group)) m.set(v.group, []);
      m.get(v.group)!.push(v);
    }
    return [...m.entries()];
  }, [voices, query]);

  function switchProvider(p: TtsProvider) {
    setCfg({ provider: p, voice: defaultVoiceOf(p), speed: cfg.speed });
  }

  async function preview() {
    setPreviewing(true);
    try {
      const r = await fetch("/api/tts/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: r.status }));
        alert("试听失败：" + (err?.error ?? r.status));
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.src = url;
        await audioRef.current.play();
      }
    } finally {
      setPreviewing(false);
    }
  }

  // 保存配置并重新生成全部配音
  async function applyAndRegen() {
    setBusy(true);
    await saveEdit(taskId, "tts", cfg); // 写 voice-config.json + 重置 tts
    await advance(taskId, "tts"); // 跑 tts
    reload();
    setBusy(false);
  }

  async function next() {
    setBusy(true);
    reload();
    navigate("image"); // 只导航到场景图，生图由场景图面板选好风格后手动触发
    setBusy(false);
  }

  return (
    <PanelShell
      title="⑥ 配音"
      hint="选择配音引擎、角色音色与语速，先试听满意再生成。重新生成会覆盖全部配音。"
      footer={
        <>
          <button onClick={applyAndRegen} disabled={busy} style={btn("ghost")}>
            {busy ? "处理中…" : done ? "应用并重新生成" : "生成配音"}
          </button>
          <button onClick={next} disabled={busy || !done} style={btn("primary")}>
            确认配音 →
          </button>
        </>
      }
    >
      <audio ref={audioRef} style={{ display: "none" }} />

      {/* 引擎切换 */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        {PROVIDERS.map((p) => {
          const on = cfg.provider === p.key;
          return (
            <button
              key={p.key}
              onClick={() => switchProvider(p.key)}
              style={{
                flex: 1,
                textAlign: "left",
                padding: "10px 14px",
                borderRadius: 10,
                border: `2px solid ${on ? T.accent : T.border}`,
                background: on ? T.accentSoft : T.panel,
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 600, color: T.text }}>{p.label}</div>
              <div style={{ fontSize: 12, color: T.textSoft, marginTop: 2 }}>{p.desc}</div>
            </button>
          );
        })}
      </div>

      {/* 语速 + 试听 + 搜索 */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: T.textSoft }}>
          语速 {cfg.speed.toFixed(1)}x
          <input
            type="range" min={0.5} max={2} step={0.1} value={cfg.speed}
            onChange={(e) => setCfg({ ...cfg, speed: Number(e.target.value) })}
            style={{ width: 140 }}
          />
        </label>
        <button onClick={preview} disabled={previewing} style={btn("ghost")}>
          {previewing ? "合成中…" : "▶ 试听当前音色"}
        </button>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索音色名…"
          style={{
            flex: 1, minWidth: 120, padding: "7px 12px", fontSize: 13,
            background: T.panel, border: `1px solid ${T.border}`, borderRadius: 7, color: T.text,
          }}
        />
      </div>

      {/* 音色分组选择 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
        {groups.map(([group, list]) => (
          <div key={group}>
            <div style={{ fontSize: 12, color: T.textFaint, marginBottom: 6 }}>{group}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {list.map((v) => {
                const on = cfg.voice === v.id;
                return (
                  <button
                    key={v.id}
                    onClick={() => setCfg({ ...cfg, voice: v.id })}
                    style={{
                      padding: "7px 14px",
                      borderRadius: 18,
                      border: `1.5px solid ${on ? T.accent : T.border}`,
                      background: on ? T.accent : T.panel,
                      color: on ? T.accentText : T.text,
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    {v.gender === "female" ? "♀ " : "♂ "}
                    {v.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {groups.length === 0 && <p style={{ color: T.textFaint }}>无匹配音色。</p>}
      </div>

      {/* 配音结果 */}
      {status === "running" ? (
        <StepLoader step={step} label="合成配音" />
      ) : done && d ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ color: T.textSoft, fontSize: 13, marginBottom: 4 }}>
            共 {d.segments.length} 段 · 总时长 {d.totalDuration.toFixed(1)}s
          </div>
          {d.segments.map((seg) => (
            <div
              key={seg.sceneId}
              style={{
                display: "flex", alignItems: "center", gap: 14,
                background: T.panelAlt, border: `1px solid ${T.border}`,
                borderRadius: 8, padding: "8px 14px",
              }}
            >
              <span style={{ color: T.textFaint, fontWeight: 700, minWidth: 22 }}>{seg.sceneId}</span>
              <audio controls src={`/api/tasks/${taskId}/file/${seg.audioPath}`} style={{ height: 34, flex: 1 }} />
              <span style={{ color: T.textSoft, fontSize: 12, minWidth: 44 }}>{seg.duration.toFixed(1)}s</span>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ color: T.textFaint }}>选好音色后点「生成配音」。</p>
      )}
    </PanelShell>
  );
}

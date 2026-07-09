"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { T, btn } from "../../../ui/theme";
import { advance, saveEdit, saveConfig, useArtifact, PanelShell, StepLoader, type PanelProps } from "./shared";
import { VOLC_VOICES, STEPFUN_VOICES, defaultVoiceOf, type TtsProvider } from "@/lib/providers/voices";

type Seg = { sceneId: number; audioPath: string; duration: number };
type Voice = { segments: Seg[]; totalDuration: number };
type VoiceModify = { pitch: number; intensity: number; timbre: number; soundEffects: string };
type Config = {
  provider: TtsProvider;
  voice: string;
  speed: number;
  vol: number;
  pitch: number;
  emotion: string;
  voiceModify: VoiceModify;
};
// 与 lib/customVoices.ts 的 CustomVoice 同形;此处本地声明,避免把 node:fs 依赖带入客户端包
type VoiceItem = { id: string; name: string; group: string; gender: "male" | "female" };
type CustomVoice = VoiceItem & { provider: TtsProvider };

const DEFAULT_VM: VoiceModify = { pitch: 0, intensity: 0, timbre: 0, soundEffects: "" };

const EMOTIONS: { v: string; label: string }[] = [
  { v: "neutral", label: "中性" }, { v: "happy", label: "开心" }, { v: "sad", label: "悲伤" },
  { v: "angry", label: "愤怒" }, { v: "fearful", label: "恐惧" }, { v: "disgusted", label: "厌恶" },
  { v: "surprised", label: "惊讶" }, { v: "calm", label: "平静" }, { v: "fluent", label: "流畅" },
  { v: "whisper", label: "耳语" },
];
const SOUND_FX: { v: string; label: string }[] = [
  { v: "", label: "无" }, { v: "spacious_echo", label: "空旷回音" }, { v: "auditorium_echo", label: "礼堂广播" },
  { v: "lofi_telephone", label: "电话失真" }, { v: "robotic", label: "电音" },
];

const PROVIDERS: { key: TtsProvider; label: string; desc: string }[] = [
  { key: "volcengine", label: "火山引擎", desc: "157 角色化音色，最丰富" },
  { key: "stepfun", label: "StepFun", desc: "通用音色，稳定" },
  { key: "aurastd", label: "Aura(克隆)", desc: "MiniMax 转发，我的复刻音色" },
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
    vol: 1.0,
    pitch: 0,
    emotion: "neutral",
    voiceModify: { ...DEFAULT_VM },
  });
  const [query, setQuery] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 自定义音色(全 provider 全量,来自 data/custom-voices.json);保存时保留非本 provider 的项,不误删
  const [allCustom, setAllCustom] = useState<CustomVoice[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newId, setNewId] = useState("");
  const [newGender, setNewGender] = useState<"male" | "female">("male");
  const [savingVoices, setSavingVoices] = useState(false);

  const status = detail.steps.find((s) => s.name === "tts")?.status;
  const done = status === "completed";
  const step = detail.steps.find((s) => s.name === "tts");

  useEffect(() => {
    read<Config>(taskId, "voice-config.json").then((x) => x && setCfg((c) => ({ ...c, ...x })));
  }, [taskId, read]);

  // 加载自定义音色清单(一次)
  useEffect(() => {
    fetch("/api/voices")
      .then((r) => r.json())
      .then((r) => { if (r.ok && Array.isArray(r.voices)) setAllCustom(r.voices); })
      .catch(() => {});
  }, []);

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

  // 本 provider 的自定义音色(目前仅 Aura 用自定义;火山/stepfun 用内置常量)
  const auraVoices = useMemo<VoiceItem[]>(
    () => allCustom.filter((v) => v.provider === "aurastd"),
    [allCustom]
  );
  const isCustom = cfg.provider === "aurastd";
  const voices: VoiceItem[] =
    cfg.provider === "volcengine" ? VOLC_VOICES : cfg.provider === "aurastd" ? auraVoices : STEPFUN_VOICES;
  const groups = useMemo(() => {
    const q = query.trim();
    const filtered = q ? voices.filter((v) => v.name.includes(q)) : voices;
    const m = new Map<string, VoiceItem[]>();
    for (const v of filtered) {
      if (!m.has(v.group)) m.set(v.group, []);
      m.get(v.group)!.push(v);
    }
    return [...m.entries()];
  }, [voices, query]);

  function switchProvider(p: TtsProvider) {
    // Aura 默认音色取自已加载的自定义清单(可能为空 → voice="");其余用内置默认
    const first = p === "aurastd" ? (auraVoices[0]?.id ?? "") : defaultVoiceOf(p);
    // 保留语速与 Aura 高级参数,只换 provider/voice
    setCfg((c) => ({ ...c, provider: p, voice: first }));
  }

  // 保存整份自定义清单到服务端(全量覆盖;PATCH 会校验+去重)。返回服务端规范化后的清单。
  async function persistVoices(next: CustomVoice[]): Promise<CustomVoice[]> {
    const r = await fetch("/api/voices", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voices: next }),
    }).then((x) => x.json()).catch(() => ({ ok: false }));
    if (!r.ok) { alert("保存音色失败:" + (r.error ?? "请重试")); return allCustom; }
    const saved: CustomVoice[] = Array.isArray(r.voices) ? r.voices : next;
    setAllCustom(saved);
    return saved;
  }

  async function addVoice() {
    const name = newName.trim();
    const id = newId.trim();
    if (!name || !id) return;
    // 同 provider 下 id 重复则提示(服务端也会去重,这里先给友好反馈)
    if (auraVoices.some((v) => v.id === id)) { alert("该音色ID已存在"); return; }
    setSavingVoices(true);
    const nonAura = allCustom.filter((v) => v.provider !== "aurastd");
    const nextAura: CustomVoice[] = [
      ...auraVoices.map((v) => ({ ...v, provider: "aurastd" as TtsProvider })),
      { provider: "aurastd", id, name, group: "我的克隆", gender: newGender },
    ];
    await persistVoices([...nonAura, ...nextAura]);
    setNewName(""); setNewId(""); setNewGender("male"); setShowAdd(false);
    setCfg((c) => ({ ...c, voice: id })); // 添加后自动选中(软保存,不重置步骤)
    setSavingVoices(false);
  }

  async function removeVoice(id: string) {
    if (!confirm("删除该音色?(仅从清单移除,不影响已生成的配音)")) return;
    setSavingVoices(true);
    const next = allCustom.filter((v) => !(v.provider === "aurastd" && v.id === id));
    const saved = await persistVoices(next);
    // 若删掉的是当前选中项,改选剩余第一个(或空)
    if (cfg.voice === id) {
      const remain = saved.filter((v) => v.provider === "aurastd");
      setCfg((c) => ({ ...c, voice: remain[0]?.id ?? "" }));
    }
    setSavingVoices(false);
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

      {/* Aura 高级参数(音量/音调/情感 + 声音效果器 + 音效)——仅 Aura 生效 */}
      {isCustom && (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 14px", marginBottom: 14, background: T.panelAlt }}>
          <div style={{ fontSize: 12, color: T.textFaint, marginBottom: 10 }}>高级(仅 Aura 生效,可留默认)</div>

          {/* 音量 / 音调 / 情感 */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center", marginBottom: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: T.textSoft }}>
              音量 {cfg.vol.toFixed(1)}
              <input type="range" min={0} max={10} step={0.5} value={cfg.vol}
                onChange={(e) => setCfg({ ...cfg, vol: Number(e.target.value) })} style={{ width: 120 }} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: T.textSoft }}>
              音调 {cfg.pitch}
              <input type="range" min={-12} max={12} step={1} value={cfg.pitch}
                onChange={(e) => setCfg({ ...cfg, pitch: Number(e.target.value) })} style={{ width: 120 }} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: T.textSoft }}>
              情感
              <select value={cfg.emotion} onChange={(e) => setCfg({ ...cfg, emotion: e.target.value })}
                style={{ padding: "6px 10px", fontSize: 13, background: T.panel, border: `1px solid ${T.border}`, borderRadius: 7, color: T.text }}>
                {EMOTIONS.map((em) => <option key={em.v} value={em.v}>{em.label}</option>)}
              </select>
            </label>
          </div>

          {/* 声音效果器 pitch/intensity/timbre */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center", marginBottom: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: T.textSoft }}>
              低沉↔明亮 {cfg.voiceModify.pitch}
              <input type="range" min={-100} max={100} step={5} value={cfg.voiceModify.pitch}
                onChange={(e) => setCfg({ ...cfg, voiceModify: { ...cfg.voiceModify, pitch: Number(e.target.value) } })} style={{ width: 120 }} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: T.textSoft }}>
              刚劲↔轻柔 {cfg.voiceModify.intensity}
              <input type="range" min={-100} max={100} step={5} value={cfg.voiceModify.intensity}
                onChange={(e) => setCfg({ ...cfg, voiceModify: { ...cfg.voiceModify, intensity: Number(e.target.value) } })} style={{ width: 120 }} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: T.textSoft }}>
              浑厚↔清脆 {cfg.voiceModify.timbre}
              <input type="range" min={-100} max={100} step={5} value={cfg.voiceModify.timbre}
                onChange={(e) => setCfg({ ...cfg, voiceModify: { ...cfg.voiceModify, timbre: Number(e.target.value) } })} style={{ width: 120 }} />
            </label>
          </div>

          {/* 音效 + 重置 */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: T.textSoft }}>
              音效
              <select value={cfg.voiceModify.soundEffects}
                onChange={(e) => setCfg({ ...cfg, voiceModify: { ...cfg.voiceModify, soundEffects: e.target.value } })}
                style={{ padding: "6px 10px", fontSize: 13, background: T.panel, border: `1px solid ${T.border}`, borderRadius: 7, color: T.text }}>
                {SOUND_FX.map((fx) => <option key={fx.v} value={fx.v}>{fx.label}</option>)}
              </select>
            </label>
            <button
              onClick={() => setCfg({ ...cfg, vol: 1.0, pitch: 0, emotion: "neutral", voiceModify: { ...DEFAULT_VM } })}
              style={{ ...btn("ghost"), fontSize: 12, padding: "6px 12px" }}
            >
              重置高级参数
            </button>
          </div>
        </div>
      )}

      {/* 音色分组选择 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
        {groups.map(([group, list]) => (
          <div key={group}>
            <div style={{ fontSize: 12, color: T.textFaint, marginBottom: 6 }}>{group}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {list.map((v) => {
                const on = cfg.voice === v.id;
                return (
                  <span key={v.id} style={{ position: "relative", display: "inline-flex" }}>
                    <button
                      onClick={() => setCfg({ ...cfg, voice: v.id })}
                      title={isCustom ? `voice_id: ${v.id}` : undefined}
                      style={{
                        padding: isCustom ? "7px 26px 7px 14px" : "7px 14px",
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
                    {isCustom && (
                      <button
                        onClick={() => removeVoice(v.id)}
                        disabled={savingVoices}
                        title="删除该音色"
                        style={{
                          position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
                          width: 16, height: 16, lineHeight: "14px", textAlign: "center",
                          borderRadius: "50%", border: "none", padding: 0,
                          background: on ? T.accentText : T.border, color: on ? T.accent : T.textSoft,
                          fontSize: 12, cursor: "pointer",
                        }}
                      >
                        ×
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
        {groups.length === 0 && !isCustom && <p style={{ color: T.textFaint }}>无匹配音色。</p>}
        {isCustom && groups.length === 0 && !query && (
          <p style={{ color: T.textFaint }}>还没有克隆音色,点下方「➕ 添加音色」录入你在 Aura 平台复刻的 voice_id。</p>
        )}

        {/* 自定义音色:添加入口 */}
        {isCustom && (
          <div>
            {!showAdd ? (
              <button onClick={() => setShowAdd(true)} style={{ ...btn("ghost"), fontSize: 13 }}>
                ➕ 添加音色
              </button>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: 12, border: `1px dashed ${T.border}`, borderRadius: 10 }}>
                <input
                  value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="显示名(如 王立群)"
                  style={{ padding: "7px 12px", fontSize: 13, background: T.panel, border: `1px solid ${T.border}`, borderRadius: 7, color: T.text, width: 150 }}
                />
                <input
                  value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="voice_id(平台复刻ID)"
                  style={{ padding: "7px 12px", fontSize: 13, fontFamily: "monospace", background: T.panel, border: `1px solid ${T.border}`, borderRadius: 7, color: T.text, flex: 1, minWidth: 220 }}
                />
                <select
                  value={newGender} onChange={(e) => setNewGender(e.target.value as "male" | "female")}
                  style={{ padding: "7px 10px", fontSize: 13, background: T.panel, border: `1px solid ${T.border}`, borderRadius: 7, color: T.text }}
                >
                  <option value="male">♂ 男</option>
                  <option value="female">♀ 女</option>
                </select>
                <button onClick={addVoice} disabled={savingVoices || !newName.trim() || !newId.trim()} style={{ ...btn("primary"), fontSize: 13 }}>
                  {savingVoices ? "保存中…" : "保存"}
                </button>
                <button onClick={() => { setShowAdd(false); setNewName(""); setNewId(""); }} disabled={savingVoices} style={{ ...btn("ghost"), fontSize: 13 }}>
                  取消
                </button>
              </div>
            )}
          </div>
        )}
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

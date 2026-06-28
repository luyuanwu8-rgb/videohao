"use client";

import { useEffect, useRef, useState } from "react";
import { T, btn } from "../../../ui/theme";
import { saveEdit, saveConfig, useArtifact, PanelShell, type PanelProps } from "./shared";
import { MOTION_PRESETS, DEFAULT_MOTION } from "@/lib/motions";

type RenderConfig = {
  motions: string[]; // 多选动效
  disclaimer: string;
  subtitleHomophone?: boolean; // 字幕高危敏感词谐音替换(健康赛道)
};

const DISCLAIMER_PRESETS = [
  "本视频内容仅供参考，不构成医疗建议",
  "本视频基于{author}《{title}》及相关资料整理，仅用于读书分享",
  "图片由 AI 生成，内容仅供娱乐参考",
  "",
];

/** ⑧风格运镜 — 多选动效预设(每选一个=多出一条成片) + 片尾声明(支持占位符) */
export function StylePanel({ taskId, reload, navigate }: PanelProps) {
  const read = useArtifact();
  const [cfg, setCfg] = useState<RenderConfig>({ motions: [DEFAULT_MOTION], disclaimer: "", subtitleHomophone: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    read<Partial<RenderConfig> & { motion?: string }>(taskId, "render-config.json").then((x) => {
      if (!x) return;
      const motions = x.motions?.length ? x.motions : [DEFAULT_MOTION];
      setCfg({ motions, disclaimer: x.disclaimer ?? "", subtitleHomophone: x.subtitleHomophone ?? false });
    });
  }, [taskId, read]);

  // 每次 cfg 变化立即软保存，不重置步骤——保证刷新后选择不丢失
  const isFirstMount = useRef(true);
  useEffect(() => {
    if (isFirstMount.current) { isFirstMount.current = false; return; }
    saveConfig(taskId, "render-config.json", cfg);
  }, [taskId, cfg]);

  function toggle(key: string) {
    setCfg((c) => {
      const has = c.motions.includes(key);
      const motions = has ? c.motions.filter((m) => m !== key) : [...c.motions, key];
      return { ...c, motions: motions.length ? motions : [key] }; // 至少保留一个
    });
  }

  async function next() {
    setBusy(true);
    await saveEdit(taskId, "style", cfg);
    // 不再直接 advance(会并发渲染致 OOM);改为加入串行成片队列
    await fetch(`/api/tasks/${taskId}/enqueue`, { method: "POST" }).catch(() => {});
    reload();
    navigate("final");
    setBusy(false);
  }

  const count = cfg.motions.length;

  return (
    <PanelShell
      title="⑧ 风格运镜"
      hint="勾选动效预设（可多选，每选一个会多生成一条成片）。确认后加入成片队列，后台串行渲染。"
      footer={
        <button onClick={next} disabled={busy} style={btn("primary")}>
          {busy ? "加入中…" : `确认，加入成片队列（${count} 条）→`}
        </button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 640 }}>
        <div>
          <div style={{ color: T.textSoft, fontSize: 13, marginBottom: 10 }}>
            动效预设（已选 {count} 个 → 出 {count} 条）
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {MOTION_PRESETS.map((m) => {
              const on = cfg.motions.includes(m.key);
              return (
                <button
                  key={m.key}
                  onClick={() => toggle(m.key)}
                  style={{
                    textAlign: "left",
                    padding: 14,
                    borderRadius: 10,
                    border: `2px solid ${on ? T.accent : T.border}`,
                    background: on ? T.accentSoft : T.panel,
                    cursor: "pointer",
                    position: "relative",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: 600, color: T.text }}>{m.label}</span>
                    <span style={{ fontSize: 14, color: on ? T.accent : T.textFaint }}>
                      {on ? "✓" : "+"}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: T.textSoft, marginTop: 4 }}>{m.desc}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div style={{ color: T.textSoft, fontSize: 13, marginBottom: 10 }}>
            片尾声明（支持占位符 {"{author}"} / {"{title}"}）
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {DISCLAIMER_PRESETS.map((p) => (
              <label
                key={p || "none"}
                style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: T.text, cursor: "pointer" }}
              >
                <input
                  type="radio"
                  checked={cfg.disclaimer === p}
                  onChange={() => setCfg({ ...cfg, disclaimer: p })}
                />
                {p || <span style={{ color: T.textFaint }}>不加声明</span>}
              </label>
            ))}
            <input
              value={DISCLAIMER_PRESETS.includes(cfg.disclaimer) ? "" : cfg.disclaimer}
              onChange={(e) => setCfg({ ...cfg, disclaimer: e.target.value })}
              placeholder="或自定义声明文字…"
              style={{
                background: T.panel, border: `1px solid ${T.border}`, borderRadius: 8,
                padding: "9px 12px", fontSize: 13, color: T.text, marginTop: 4,
              }}
            />
          </div>
        </div>

        <div>
          <div style={{ color: T.textSoft, fontSize: 13, marginBottom: 10 }}>
            字幕合规（健康赛道）
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: T.text, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={!!cfg.subtitleHomophone}
              onChange={(e) => setCfg({ ...cfg, subtitleHomophone: e.target.checked })}
            />
            <span>
              高危敏感词谐音替换
              <span style={{ color: T.textFaint, marginLeft: 8 }}>
                （治疗→ZL、血管→x管、养生→Y生… 规避机审，仅替换高危词，可在字幕后人工微调）
              </span>
            </span>
          </label>
        </div>
      </div>
    </PanelShell>
  );
}

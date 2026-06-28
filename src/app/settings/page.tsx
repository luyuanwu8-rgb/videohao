"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { T, btn } from "../ui/theme";

type Config = {
  id: string;
  provider: string;
  key: string;
  description: string | null;
  isSecret: boolean;
  hasValue: boolean;
  value: string;
};

const PROVIDER_LABEL: Record<string, string> = {
  llm: "LLM（改写/分析/分镜）",
  stepfun: "StepFun（ASR + TTS）",
  volcengine: "火山引擎（TTS）",
  gptimage: "gpt-image（生图）",
  tikhub: "TikHub（抖音解析）",
  global: "全局开关",
};

export default function SettingsPage() {
  const [configs, setConfigs] = useState<Config[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savedKey, setSavedKey] = useState<string>("");

  async function load() {
    const r = await fetch("/api/settings").then((r) => r.json());
    if (r.ok) setConfigs(r.configs);
  }
  useEffect(() => {
    load();
  }, []);

  async function save(key: string) {
    const value = edits[key];
    if (value === undefined) return;
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    setSavedKey(key);
    setTimeout(() => setSavedKey(""), 1500);
    setEdits((e) => { const n = { ...e }; delete n[key]; return n; });
    await load();
  }

  // 按 provider 分组
  const groups = configs.reduce<Record<string, Config[]>>((acc, c) => {
    (acc[c.provider] = acc[c.provider] ?? []).push(c);
    return acc;
  }, {});

  const field: React.CSSProperties = {
    flex: 1,
    background: T.panel,
    border: `1px solid ${T.border}`,
    borderRadius: 7,
    padding: "7px 11px",
    fontSize: 13,
    color: T.text,
    fontFamily: "inherit",
    boxSizing: "border-box",
  };

  return (
    <div style={{ minHeight: "100vh", background: T.bg }}>
      <main style={{ maxWidth: 860, margin: "0 auto", padding: "28px 24px" }}>
        <Link href="/" style={{ color: T.textSoft, fontSize: 13, textDecoration: "none" }}>← 返回首页</Link>
        <h1 style={{ fontSize: 22, color: T.text, margin: "10px 0 4px" }}>API 设置</h1>
        <p style={{ color: T.textSoft, fontSize: 13, marginBottom: 24 }}>
          配置各服务的接口地址、密钥与模型。密钥脱敏显示，留空保存表示不修改原值。保存后立即生效。
        </p>

        {Object.entries(groups).map(([provider, items]) => (
          <div key={provider} style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 15, color: T.text, marginBottom: 12, borderBottom: `1px solid ${T.border}`, paddingBottom: 6 }}>
              {PROVIDER_LABEL[provider] ?? provider}
            </h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {items.map((c) => (
                <div key={c.key} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 200, flexShrink: 0 }}>
                    <div style={{ fontSize: 13, color: T.text, fontFamily: "monospace" }}>{c.key}</div>
                    <div style={{ fontSize: 11, color: T.textFaint }}>{c.description}</div>
                  </div>
                  <input
                    value={edits[c.key] ?? (c.isSecret ? "" : c.value)}
                    onChange={(e) => setEdits((s) => ({ ...s, [c.key]: e.target.value }))}
                    placeholder={c.isSecret ? (c.hasValue ? `已设置（${c.value}），留空不改` : "未设置") : ""}
                    style={field}
                  />
                  <button
                    onClick={() => save(c.key)}
                    disabled={edits[c.key] === undefined}
                    style={{ ...btn("ghost"), fontSize: 12, padding: "6px 14px", color: savedKey === c.key ? T.completed : T.textSoft }}
                  >
                    {savedKey === c.key ? "✓" : "保存"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </main>
    </div>
  );
}

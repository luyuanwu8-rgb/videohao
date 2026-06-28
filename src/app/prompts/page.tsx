"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { T, btn } from "../ui/theme";

type Prompt = { id: string | null; step: string; track: string; system: string; buildTemplate: string };
type FilterRule = { from: string; to: string };

const STEP_LABEL: Record<string, string> = { viralAnalyze: "爆款分析", rewrite: "改写", storyboard: "分镜" };
const PLACEHOLDER_HINT: Record<string, string> = {
  viralAnalyze: "可用占位符：{transcript}",
  rewrite: "可用占位符：{transcript} {viral}",
  storyboard: "可用占位符：{script}",
};

const SUBTITLE_KEY = "__subtitle_filters__";

const field: React.CSSProperties = {
  width: "100%", background: T.panel, border: `1px solid ${T.border}`, borderRadius: 8,
  padding: "10px 12px", fontSize: 13, color: T.text, fontFamily: "inherit",
  boxSizing: "border-box", resize: "vertical", lineHeight: 1.6,
};

export default function PromptsPage() {
  const [list, setList] = useState<Prompt[]>([]);
  const [sel, setSel] = useState<string>(""); // step/track or SUBTITLE_KEY
  const [draft, setDraft] = useState<Prompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // 字幕词库状态
  const [rules, setRules] = useState<FilterRule[]>([]);
  const [newFrom, setNewFrom] = useState("");
  const [newTo, setNewTo] = useState("");
  const [filterSaved, setFilterSaved] = useState(false);

  async function load() {
    const r = await fetch("/api/prompts").then((r) => r.json());
    if (r.ok) {
      setList(r.prompts);
      if (!sel && r.prompts.length) {
        const first = r.prompts[0];
        setSel(`${first.step}/${first.track}`);
        setDraft(first);
      }
    }
  }
  async function loadFilters() {
    const r = await fetch("/api/subtitle-filters").then((r) => r.json());
    if (r.ok) setRules(r.rules);
  }
  useEffect(() => { load(); loadFilters(); }, []);

  function pick(key: string, p?: Prompt) {
    setSel(key); setDraft(p ?? null); setSaved(false); setFilterSaved(false);
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    await fetch("/api/prompts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
    setSaved(true); await load(); setBusy(false);
  }
  async function restore() {
    if (!draft) return;
    setBusy(true);
    const r = await fetch("/api/prompts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore", step: draft.step, track: draft.track }) }).then((r) => r.json());
    if (r.ok) setDraft({ ...draft, system: r.system, buildTemplate: r.buildTemplate });
    await load(); setBusy(false);
  }

  async function saveFilters() {
    setBusy(true);
    await fetch("/api/subtitle-filters", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules }) });
    setFilterSaved(true); setBusy(false);
  }
  function addRule() {
    if (!newFrom.trim()) return;
    setRules([...rules, { from: newFrom.trim(), to: newTo.trim() }]);
    setNewFrom(""); setNewTo(""); setFilterSaved(false);
  }

  const isFilters = sel === SUBTITLE_KEY;

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: T.bg }}>
      <aside style={{ width: 220, background: T.sidebar, borderRight: `1px solid ${T.border}`, padding: 16, overflowY: "auto" }}>
        <Link href="/" style={{ color: T.textSoft, fontSize: 13, textDecoration: "none" }}>← 返回首页</Link>
        <h2 style={{ fontSize: 16, color: T.text, margin: "12px 0" }}>提示词管理</h2>
        {list.map((p) => {
          const key = `${p.step}/${p.track}`;
          return (
            <button key={key} onClick={() => pick(key, p)} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", borderRadius: 7, border: "none", marginBottom: 4, cursor: "pointer", background: sel === key ? T.panel : "transparent", color: T.text, fontSize: 13, boxShadow: sel === key ? `inset 3px 0 0 ${T.accent}` : "none" }}>
              {STEP_LABEL[p.step] ?? p.step}
              <span style={{ color: T.textFaint, marginLeft: 6 }}>{p.track}</span>
            </button>
          );
        })}
        {/* 字幕词库入口 */}
        <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 12, paddingTop: 12 }}>
          <button onClick={() => pick(SUBTITLE_KEY)} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", borderRadius: 7, border: "none", cursor: "pointer", background: isFilters ? T.panel : "transparent", color: T.text, fontSize: 13, boxShadow: isFilters ? `inset 3px 0 0 ${T.accent}` : "none" }}>
            🔤 字幕词库
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, padding: "24px 32px", overflowY: "auto" }}>
        {isFilters ? (
          <div style={{ maxWidth: 680 }}>
            <h1 style={{ fontSize: 20, color: T.text, margin: 0 }}>字幕过滤词库</h1>
            <p style={{ color: T.textSoft, fontSize: 12, margin: "6px 0 18px" }}>字幕生成时自动替换以下词汇。格式：原词 → 替换显示（如 细胞=XB、慢性病=慢性寎）</p>

            {/* 规则列表 */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
              {rules.map((r, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input value={r.from} onChange={(e) => { const n=[...rules]; n[i]={...n[i],from:e.target.value}; setRules(n); setFilterSaved(false); }} style={{ ...field, width: 140, resize: "none" }} />
                  <span style={{ color: T.textSoft }}>→</span>
                  <input value={r.to} onChange={(e) => { const n=[...rules]; n[i]={...n[i],to:e.target.value}; setRules(n); setFilterSaved(false); }} style={{ ...field, width: 140, resize: "none" }} />
                  <button onClick={() => { setRules(rules.filter((_,j)=>j!==i)); setFilterSaved(false); }} style={{ ...btn("ghost"), padding: "4px 10px", color: T.failed }}>删</button>
                </div>
              ))}
            </div>

            {/* 新增一条 */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, paddingTop: 8, borderTop: `1px dashed ${T.border}` }}>
              <input value={newFrom} onChange={(e) => setNewFrom(e.target.value)} placeholder="原词" style={{ ...field, width: 140, resize: "none" }} onKeyDown={(e) => e.key === "Enter" && addRule()} />
              <span style={{ color: T.textSoft }}>→</span>
              <input value={newTo} onChange={(e) => setNewTo(e.target.value)} placeholder="替换" style={{ ...field, width: 140, resize: "none" }} onKeyDown={(e) => e.key === "Enter" && addRule()} />
              <button onClick={addRule} style={btn("ghost")}>+ 添加</button>
            </div>

            <button onClick={saveFilters} disabled={busy} style={btn("primary")}>
              {busy ? "保存中…" : filterSaved ? "✓ 已保存" : "保存词库"}
            </button>
          </div>
        ) : !draft ? (
          <p style={{ color: T.textSoft }}>加载中…</p>
        ) : (
          <div style={{ maxWidth: 820 }}>
            <h1 style={{ fontSize: 20, color: T.text, margin: 0 }}>
              {STEP_LABEL[draft.step] ?? draft.step}
              <span style={{ color: T.textFaint, fontSize: 14, marginLeft: 8 }}>{draft.track} 赛道</span>
            </h1>
            <p style={{ color: T.textSoft, fontSize: 12, margin: "6px 0 18px" }}>{PLACEHOLDER_HINT[draft.step] ?? ""}</p>
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: T.textSoft, fontSize: 13, marginBottom: 6 }}>System（系统提示·角色与规则）</div>
              <textarea value={draft.system} onChange={(e) => { setDraft({ ...draft, system: e.target.value }); setSaved(false); }} rows={14} style={field} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: T.textSoft, fontSize: 13, marginBottom: 6 }}>Build 模板（用户提示·含 {"{占位符}"}）</div>
              <textarea value={draft.buildTemplate} onChange={(e) => { setDraft({ ...draft, buildTemplate: e.target.value }); setSaved(false); }} rows={5} style={field} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={save} disabled={busy} style={btn("primary")}>{busy ? "保存中…" : saved ? "✓ 已保存" : "保存"}</button>
              <button onClick={restore} disabled={busy} style={btn("ghost")}>恢复出厂默认</button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

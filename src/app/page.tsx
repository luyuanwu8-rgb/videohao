"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { T, STATUS_COLOR, STATUS_LABEL, btn, cardStyle } from "./ui/theme";

type Task = {
  id: string;
  status: string;
  title: string | null;
  sourceUrl: string | null;
  track: string;
  error: string | null;
  createdAt: number;
};

type QueueSnapshot = { current: string | null; waiting: string[] };

/** createdAt(秒级时间戳)→ "YYYY-MM-DD HH:mm" */
function fmtTime(sec: number): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [queue, setQueue] = useState<QueueSnapshot>({ current: null, waiting: [] });
  const [url, setUrl] = useState("");
  const [script, setScript] = useState("");
  const [mode, setMode] = useState<"link" | "script">("link"); // 抖音链接 / 自带文案
  const [track, setTrack] = useState("health");
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<Record<string, boolean>>({});

  // 记住上次选的模式/赛道(下次进来自动带出),链接/文案内容除外
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem("videohao.home.prefs.v1") || "{}");
      if (s.mode === "link" || s.mode === "script") setMode(s.mode);
      if (typeof s.track === "string") setTrack(s.track);
    } catch { /* 忽略损坏本地数据 */ }
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (!prefsLoaded) return;
    try { localStorage.setItem("videohao.home.prefs.v1", JSON.stringify({ mode, track })); } catch { /* 忽略 */ }
  }, [prefsLoaded, mode, track]);

  async function load() {
    const r = await fetch("/api/tasks").then((r) => r.json());
    if (r.ok) {
      setTasks(r.tasks);
      if (r.queue) setQueue(r.queue);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  async function pauseTask(id: string, e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    setActionBusy((b) => ({ ...b, [id]: true }));
    await fetch(`/api/tasks/${id}/pause`, { method: "POST" });
    await load();
    setActionBusy((b) => ({ ...b, [id]: false }));
  }

  async function deleteTask(id: string, e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    if (!confirm("确认删除这个任务？将永久删除它的成品视频、图片等全部文件,操作不可撤销。")) return;
    setActionBusy((b) => ({ ...b, [id]: true }));
    const r = await fetch(`/api/tasks/${id}`, { method: "DELETE" }).then((r) => r.json()).catch(() => ({ ok: false, error: "网络错误" }));
    if (!r.ok) {
      alert(`删除失败:${r.error ?? "未知错误"}`);
    } else if (r.freedBytes) {
      // 静默成功即可,腾出空间在列表刷新后体现
    }
    await load();
    setActionBusy((b) => ({ ...b, [id]: false }));
  }

  const [cleaning, setCleaning] = useState(false);
  async function cleanupJunk() {
    setCleaning(true);
    try {
      const r = await fetch("/api/cleanup", { method: "POST" }).then((r) => r.json()).catch(() => ({ ok: false }));
      if (r.ok) {
        const mb = Math.round((r.bytes ?? 0) / 1048576);
        alert(r.dirs > 0 ? `已清理 ${r.dirs} 个临时目录,腾出约 ${mb} MB` : "没有可清理的临时垃圾");
      } else {
        alert("清理失败,请稍后再试");
      }
      await load();
    } finally {
      setCleaning(false);
    }
  }

  async function create() {
    const payload =
      mode === "script"
        ? { script: script.trim(), track }
        : { sourceUrl: url.trim(), track };
    if (mode === "script" ? !payload.script : !payload.sourceUrl) return;
    setBusy(true);
    try {
      await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setUrl("");
      setScript("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    padding: "11px 14px",
    background: T.panel,
    border: `1px solid ${T.border}`,
    borderRadius: 8,
    color: T.text,
    fontSize: 14,
  };

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "40px 24px" }}>
      <header style={{ marginBottom: 28, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: 26, margin: 0, color: T.text }}>
            📚 图书带货视频工厂
          </h1>
          <p style={{ color: T.textSoft, marginTop: 6, fontSize: 14 }}>
            粘贴抖音分享链接，分步生成逐字稿 / 改写 / 分镜 / 配音 / 场景图 / 成片
          </p>
        </div>
        <nav style={{ display: "flex", gap: 14, fontSize: 13, paddingTop: 6 }}>
          <Link href="/quick" style={{ color: T.accentText, background: T.accent, padding: "6px 14px", borderRadius: 7, textDecoration: "none", fontWeight: 600 }}>⚡ 快速制作</Link>
          <Link href="/prompts" style={{ color: T.accent, textDecoration: "none", alignSelf: "center" }}>提示词管理</Link>
          <Link href="/settings" style={{ color: T.accent, textDecoration: "none", alignSelf: "center" }}>API 设置</Link>
        </nav>
      </header>

      <div style={{ ...cardStyle, marginBottom: 28 }}>
        {/* 模式切换：抖音链接 / 自带文案 */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {([["link", "抖音链接"], ["script", "自带文案"]] as const).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: "6px 16px", borderRadius: 7, fontSize: 13, cursor: "pointer",
                border: `1.5px solid ${mode === m ? T.accent : T.border}`,
                background: mode === m ? T.accent : T.panel,
                color: mode === m ? T.accentText : T.text,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: mode === "script" ? "flex-end" : "center" }}>
          {mode === "link" ? (
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              placeholder="粘贴抖音分享链接，回车或点新建…"
              style={{ ...inputStyle, flex: 1 }}
            />
          ) : (
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder="粘贴你的口播文案（已定稿，将跳过抖音解析与 AI 改写，直接切分镜→生成）…"
              style={{ ...inputStyle, flex: 1, minHeight: 120, resize: "vertical", lineHeight: 1.7, fontFamily: "inherit" }}
            />
          )}
          <select
            value={track}
            onChange={(e) => setTrack(e.target.value)}
            style={inputStyle}
          >
            <option value="health">养生</option>
            <option value="emotion">情感</option>
            <option value="parenting">亲子</option>
          </select>
          <button onClick={create} disabled={busy} style={btn("primary")}>
            {busy ? "创建中…" : "新建任务"}
          </button>
        </div>
      </div>

      <div
        style={{
          ...cardStyle,
          padding: "12px 18px",
          marginBottom: 16,
          borderLeft: `4px solid ${T.queued}`,
          display: "flex",
          alignItems: "center",
          gap: 16,
          fontSize: 14,
        }}
      >
        <span style={{ color: T.queued, fontWeight: 600 }}>🎬 成片队列</span>
        <span style={{ color: T.text }}>
          {queue.current ? "渲染中 1 条" : "空闲"}
          {queue.waiting.length > 0 && `，等待 ${queue.waiting.length} 条`}
        </span>
        <span style={{ color: T.textSoft, fontSize: 12 }}>
          {queue.current ? "（串行渲染，完成后自动处理下一条）" : "（在⑧风格运镜确认后自动入队）"}
        </span>
        <button
          onClick={cleanupJunk}
          disabled={cleaning}
          title="清理渲染中断残留的临时废文件(不影响成品/图片)"
          style={{
            marginLeft: "auto", padding: "5px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer",
            border: `1px solid ${T.border}`, background: T.panel, color: T.textSoft,
          }}
        >
          {cleaning ? "清理中…" : "🧹 清理垃圾"}
        </button>
      </div>

      <h2 style={{ fontSize: 16, color: T.textSoft, marginBottom: 12 }}>
        我的任务
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {tasks.map((t) => (
          <div key={t.id} style={{ position: "relative" }}>
            <Link
              href={`/tasks/${t.id}`}
              style={{
                ...cardStyle,
                padding: "14px 18px",
                paddingRight: 120,
                textDecoration: "none",
                color: T.text,
                display: "block",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: 15 }}>{t.title ?? "（待解析）"}</strong>
                <span style={{ color: STATUS_COLOR[t.status] ?? T.textFaint, fontSize: 13, fontWeight: 600 }}>
                  ● {STATUS_LABEL[t.status] ?? t.status}
                </span>
              </div>
              <div style={{ fontSize: 12, color: T.textFaint, marginTop: 5 }}>
                🕐 {fmtTime(t.createdAt)} · {t.track}{t.sourceUrl ? ` · ${t.sourceUrl}` : ""}
              </div>
              {t.error && (
                <div style={{ fontSize: 12, color: T.failed, marginTop: 4 }}>{t.error}</div>
              )}
            </Link>
            {/* 操作按钮浮层 */}
            <div style={{
              position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)",
              display: "flex", gap: 6,
            }}>
              {(t.status === "running" || t.status === "paused") && (
                <button
                  onClick={(e) => pauseTask(t.id, e)}
                  disabled={actionBusy[t.id]}
                  title={t.status === "paused" ? "恢复" : "暂停"}
                  style={{
                    padding: "5px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                    border: `1px solid ${T.border}`, background: T.panel,
                    color: t.status === "paused" ? T.completed : T.running,
                  }}
                >
                  {actionBusy[t.id] ? "…" : t.status === "paused" ? "▶ 恢复" : "⏸ 暂停"}
                </button>
              )}
              <button
                onClick={(e) => deleteTask(t.id, e)}
                disabled={actionBusy[t.id]}
                title="删除"
                style={{
                  padding: "5px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                  border: `1px solid ${T.border}`, background: T.panel, color: T.failed,
                }}
              >
                {actionBusy[t.id] ? "…" : "🗑 删除"}
              </button>
            </div>
          </div>
        ))}
        {tasks.length === 0 && (
          <p style={{ color: T.textFaint }}>
            还没有任务，粘贴一个抖音链接试试。
          </p>
        )}
      </div>
    </main>
  );
}

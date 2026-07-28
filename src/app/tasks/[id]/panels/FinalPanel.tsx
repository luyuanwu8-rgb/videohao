"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { T, btn } from "../../../ui/theme";
import {
  advance,
  PanelShell,
  type Artifact,
  type PanelProps,
} from "./shared";
import { motionPreset } from "@/lib/motions";

type PublishTag = {
  text: string;
  evidence: string;
  kind: "book" | "theme" | "problem" | "audience";
};

type PublishKit = {
  status: "pending" | "generating" | "completed" | "partial" | "failed";
  title: string;
  subtitle: string;
  caption: string;
  tags: PublishTag[];
  comments: { conversion: string; purchase: string };
  fullScript: string;
  cover: {
    status: "pending" | "generating" | "completed" | "failed";
    path: string;
    title: string;
    subtitle: string;
    error: string;
    generatedAt: number;
    cost: number;
  };
  error: string;
  warnings: string[];
  updatedAt: number;
};

type Draft = {
  title: string;
  subtitle: string;
  caption: string;
  tagsText: string;
  conversionComment: string;
  purchaseComment: string;
  fullScript: string;
};

function draftOf(kit: PublishKit): Draft {
  return {
    title: kit.title,
    subtitle: kit.subtitle,
    caption: kit.caption,
    tagsText: kit.tags.map((item) => item.text).join(" "),
    conversionComment: kit.comments.conversion,
    purchaseComment: kit.comments.purchase,
    fullScript: kit.fullScript,
  };
}

function materialText(draft: Draft): string {
  return [
    "【作品标题】",
    draft.title,
    "",
    "【发布文案】",
    draft.caption,
    "",
    "【话题标签】",
    draft.tagsText,
    "",
    "【评论区】",
    "评论1：",
    draft.conversionComment,
    "",
    "评论2：",
    draft.purchaseComment,
    "",
    "【完整文案】",
    draft.fullScript,
  ].join("\n");
}

function safeFileName(raw: string): string {
  const value = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 60);
  return value || "视频发布资料";
}

async function writeResponseToDirectory(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  url: string
) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await response.text());
  if (!response.body) throw new Error(`${fileName}读取失败`);
  const file = await directory.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await response.body.pipeTo(writable);
}

async function writeTextToDirectory(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  content: string
) {
  const file = await directory.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(
    new Blob([`\uFEFF${content}`], { type: "text/plain;charset=utf-8" })
  );
  await writable.close();
}

function downloadUrl(url: string, fileName: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function FinalPanel({ taskId, detail, reload }: PanelProps) {
  const [renderBusy, setRenderBusy] = useState(false);
  const [kitBusy, setKitBusy] = useState<"" | "save" | "text" | "cover" | "export">("");
  const [kit, setKit] = useState<PublishKit | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedDraft, setSavedDraft] = useState<Draft | null>(null);
  const [copied, setCopied] = useState("");
  const [message, setMessage] = useState("");
  const [sel, setSel] = useState(0);

  const status = detail.steps.find((s) => s.name === "render")?.status;
  const renderStep = detail.steps.find((s) => s.name === "render");
  const done = status === "completed";

  const renderStartedAt = renderStep?.startedAt ?? 0;
  const latestMp4 = new Map<string, Artifact>();
  for (const artifact of detail.artifacts ?? []) {
    if (artifact.fileType !== "mp4") continue;
    if ((artifact.createdAt ?? 0) < renderStartedAt) continue;
    const old = latestMp4.get(artifact.filePath);
    if (
      !old ||
      artifact.version > old.version ||
      (artifact.createdAt ?? 0) > (old.createdAt ?? 0)
    ) {
      latestMp4.set(artifact.filePath, artifact);
    }
  }
  const renders = [...latestMp4.values()]
    .filter((artifact) => artifact.filePath.startsWith("renders/"))
    .map((artifact) => {
      const key = artifact.filePath
        .replace(/^renders\//, "")
        .replace(/\.mp4$/, "");
      return { key, path: artifact.filePath, label: motionPreset(key).label };
    });
  const clips =
    renders.length > 0
      ? renders
      : [{ key: "final", path: "final.mp4", label: "成片" }];
  const active = clips[Math.min(sel, clips.length - 1)];

  const loadKit = useCallback(async (): Promise<PublishKit | null> => {
    const response = await fetch(`/api/tasks/${taskId}/publish-kit`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { ok: boolean; kit: PublishKit | null };
    if (!data.ok) return null;
    setKit(data.kit);
    if (data.kit) {
      const next = draftOf(data.kit);
      setDraft((current) => {
        if (!current || JSON.stringify(current) === JSON.stringify(savedDraft)) {
          return next;
        }
        return current;
      });
      setSavedDraft(next);
    }
    return data.kit;
  }, [taskId, savedDraft]);

  useEffect(() => {
    if (!done) return;
    let cancelled = false;
    let started = false;
    const poll = async () => {
      const current = await loadKit();
      if (cancelled) return;
      if (!current && !started) {
        started = true;
        await fetch(`/api/tasks/${taskId}/publish-kit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "all" }),
        });
        await loadKit();
      }
    };
    void poll();
    const timer = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [done, loadKit, taskId]);

  const dirty = useMemo(
    () =>
      !!draft &&
      !!savedDraft &&
      JSON.stringify(draft) !== JSON.stringify(savedDraft),
    [draft, savedDraft]
  );
  const coverMismatch =
    !!kit &&
    !!draft &&
    (kit.cover.title !== draft.title || kit.cover.subtitle !== draft.subtitle);

  async function rebuild() {
    setRenderBusy(true);
    await advance(taskId, "final");
    reload();
    setRenderBusy(false);
  }

  function flash(text: string) {
    setMessage(text);
    setTimeout(() => setMessage(""), 1800);
  }

  function copy(key: string, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(""), 1500);
    });
  }

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save(): Promise<boolean> {
    if (!draft) return false;
    setKitBusy("save");
    const tags = draft.tagsText
      .split(/[\s,，]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const response = await fetch(`/api/tasks/${taskId}/publish-kit`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: draft.title,
        subtitle: draft.subtitle,
        caption: draft.caption,
        tags,
        conversionComment: draft.conversionComment,
        purchaseComment: draft.purchaseComment,
        fullScript: draft.fullScript,
      }),
    });
    const data = await response.json().catch(() => ({}));
    setKitBusy("");
    if (!response.ok || !data.ok) {
      flash(data.error || "保存失败");
      return false;
    }
    setKit(data.kit);
    const next = draftOf(data.kit);
    setDraft(next);
    setSavedDraft(next);
    flash("已保存");
    return true;
  }

  async function regenerate(action: "text" | "cover") {
    if (dirty && !(await save())) return;
    setKitBusy(action);
    const response = await fetch(`/api/tasks/${taskId}/publish-kit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = await response.json().catch(() => ({}));
    setKitBusy("");
    if (!response.ok || !data.ok) {
      flash(data.error || "启动失败");
      return;
    }
    flash(action === "cover" ? "封面任务已启动" : "文字任务已启动");
    await loadKit();
  }

  async function exportPackage() {
    const picker = (
      window as Window & {
        showDirectoryPicker?: (options?: {
          mode?: "read" | "readwrite";
        }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;
    let root: FileSystemDirectoryHandle | null = null;
    try {
      // 目录选择必须紧跟用户点击；先取得句柄，再保存可能存在的编辑。
      if (picker) root = await picker.call(window, { mode: "readwrite" });
      if (dirty && !(await save())) return;
      if (!draft || !kit?.cover.path) return;
      setKitBusy("export");
      const title = safeFileName(draft.title);
      const videoUrl = `/api/tasks/${taskId}/file/${active.path}`;
      const coverUrl = `/api/tasks/${taskId}/file/${kit.cover.path}?v=${kit.cover.generatedAt}`;
      if (root) {
        const folder = await root.getDirectoryHandle(title, { create: true });
        await writeTextToDirectory(
          folder,
          `${title}.txt`,
          materialText(draft)
        );
        await writeResponseToDirectory(folder, `${title}.mp4`, videoUrl);
        await writeResponseToDirectory(
          folder,
          `${title}-封面.png`,
          coverUrl
        );
        flash(`已导出到文件夹「${title}」`);
      } else {
        const textUrl = URL.createObjectURL(
          new Blob([`\uFEFF${materialText(draft)}`], {
            type: "text/plain;charset=utf-8",
          })
        );
        downloadUrl(textUrl, `${title}.txt`);
        URL.revokeObjectURL(textUrl);
        downloadUrl(videoUrl, `${title}.mp4`);
        downloadUrl(coverUrl, `${title}-封面.png`);
        flash("已分别下载发布资料、成片和封面");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        flash("已取消导出");
      } else {
        flash(error instanceof Error ? error.message : "导出失败");
      }
    } finally {
      setKitBusy("");
    }
  }

  const field: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    border: `1px solid ${T.border}`,
    borderRadius: 8,
    background: T.panelAlt,
    color: T.text,
    padding: "9px 11px",
    lineHeight: 1.6,
    resize: "vertical",
    fontFamily: "inherit",
  };
  const smallButton = (key = ""): React.CSSProperties => ({
    ...btn("ghost"),
    fontSize: 12,
    padding: "4px 10px",
    color: copied === key ? T.completed : T.textSoft,
  });

  return (
    <PanelShell
      title="⑨ 成片 + 发布"
      hint={
        done
          ? "成片已生成。右侧发布资料可编辑、复制，并与当前成片和独立封面一起导出。"
          : "正在合成时间线并渲染成片…"
      }
      footer={
        <button onClick={rebuild} disabled={renderBusy} style={btn("ghost")}>
          {renderBusy ? "处理中…" : "重新合成"}
        </button>
      }
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(300px, 330px) minmax(520px, 1fr)",
          gap: 28,
          alignItems: "start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {!done ? (
            <div
              style={{
                width: 300,
                height: 533,
                borderRadius: 14,
                background: "#000",
                border: `1px solid ${T.border}`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 14,
                padding: 24,
                color: T.textFaint,
                fontSize: 13,
                textAlign: "center",
              }}
            >
              {status === "failed" ? (
                "渲染失败，点「重新合成」"
              ) : (() => {
                const progress = detail.progress?.render;
                if (!progress) return <span>渲染中…</span>;
                const pct = progress.total
                  ? Math.round((progress.done / progress.total) * 100)
                  : 0;
                return (
                  <>
                    <div style={{ fontSize: 28 }}>🎬</div>
                    <div style={{ color: T.text, fontWeight: 600 }}>
                      {progress.done < progress.total
                        ? "分段渲染中"
                        : "合成中 · 最后一步"}
                    </div>
                    <div>
                      {progress.done} / {progress.total} 段 · {pct}%
                    </div>
                  </>
                );
              })()}
            </div>
          ) : (
            <>
              {clips.length > 1 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {clips.map((clip, index) => {
                    const selected = index === sel;
                    return (
                      <button
                        key={clip.key}
                        onClick={() => setSel(index)}
                        style={{
                          fontSize: 12,
                          padding: "5px 12px",
                          borderRadius: 16,
                          border: `1.5px solid ${selected ? T.accent : T.border}`,
                          background: selected ? T.accent : T.panel,
                          color: selected ? T.accentText : T.text,
                          cursor: "pointer",
                        }}
                      >
                        {clip.label}
                      </button>
                    );
                  })}
                </div>
              )}
              <video
                key={active.path}
                src={`/api/tasks/${taskId}/file/${active.path}`}
                controls
                style={{
                  width: 300,
                  borderRadius: 14,
                  background: "#000",
                  border: `1px solid ${T.border}`,
                }}
              />
              <button
                onClick={() => draft && copy("all", materialText(draft))}
                disabled={!draft}
                style={{
                  ...smallButton("all"),
                  width: 300,
                  padding: "9px 12px",
                  textAlign: "center",
                }}
              >
                {copied === "all" ? "✓ 已复制" : "复制发布资料"}
              </button>
              <button
                onClick={() => void exportPackage()}
                disabled={!draft || !!kitBusy || !kit?.cover.path}
                style={{ ...btn("primary"), width: 300, textAlign: "center" }}
              >
                {kitBusy === "export" ? "导出中…" : "导出完整发布资料"}
              </button>
              {message && (
                <div
                  style={{
                    width: 300,
                    color: T.textSoft,
                    fontSize: 12,
                    textAlign: "center",
                  }}
                >
                  {message}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ minWidth: 0 }}>
          {!done ? (
            <div style={{ color: T.textFaint, padding: "28px 0" }}>
              成片完成后将自动生成发布资料和独立封面。
            </div>
          ) : !kit || !draft ? (
            <div style={{ color: T.textSoft, padding: "28px 0" }}>
              正在准备发布资料…
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, color: T.text }}>发布资料</div>
                  <div style={{ fontSize: 12, color: T.textSoft, marginTop: 3 }}>
                    {kit.status === "generating"
                      ? "AI生成中…"
                      : dirty
                        ? "有内容尚未保存"
                        : "所有修改已保存"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    onClick={() => void regenerate("text")}
                    disabled={!!kitBusy || kit.status === "generating"}
                    style={smallButton()}
                  >
                    {kitBusy === "text" ? "启动中…" : "重新生成文字"}
                  </button>
                  <button
                    onClick={() => void save()}
                    disabled={!dirty || !!kitBusy}
                    style={btn("primary")}
                  >
                    {kitBusy === "save" ? "保存中…" : "保存修改"}
                  </button>
                </div>
              </div>

              {(kit.error || kit.warnings.length > 0 || coverMismatch) && (
                <div
                  style={{
                    border: `1px solid ${kit.error ? T.failed : T.borderStrong}`,
                    background: kit.error ? "rgba(190,60,45,.08)" : T.panelAlt,
                    borderRadius: 8,
                    padding: "9px 11px",
                    fontSize: 12,
                    color: kit.error ? T.failed : T.textSoft,
                    lineHeight: 1.6,
                  }}
                >
                  {kit.error && <div>{kit.error}</div>}
                  {kit.warnings.map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                  {coverMismatch && (
                    <div>当前作品标题与封面中的文字不一致，可单独重新生成封面。</div>
                  )}
                </div>
              )}

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "190px minmax(0,1fr)",
                  gap: 16,
                  alignItems: "start",
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                    🖼 独立封面
                  </div>
                  <div
                    style={{
                      width: 180,
                      aspectRatio: "9 / 16",
                      borderRadius: 10,
                      overflow: "hidden",
                      background: "#17120d",
                      border: `1px solid ${T.border}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: T.textFaint,
                      fontSize: 12,
                      textAlign: "center",
                    }}
                  >
                    {kit.cover.path ? (
                      <img
                        src={`/api/tasks/${taskId}/file/${kit.cover.path}?v=${kit.cover.generatedAt}`}
                        alt="发布封面"
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    ) : kit.cover.status === "generating" ? (
                      "封面生成中…"
                    ) : (
                      "封面尚未生成"
                    )}
                  </div>
                  <button
                    onClick={() => void regenerate("cover")}
                    disabled={!!kitBusy || kit.cover.status === "generating"}
                    style={{ ...smallButton(), width: 180, marginTop: 8 }}
                    title="每次重新生成会调用一次生图接口"
                  >
                    {kitBusy === "cover" ? "启动中…" : "重新生成封面"}
                  </button>
                  {kit.cover.error && (
                    <div style={{ color: T.failed, fontSize: 11, marginTop: 6 }}>
                      {kit.cover.error}
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <label style={{ fontSize: 13, fontWeight: 600 }}>
                    作品标题
                    <input
                      value={draft.title}
                      onChange={(event) => update("title", event.target.value)}
                      style={{ ...field, marginTop: 6 }}
                    />
                    <span style={{ float: "right", color: T.textFaint, fontSize: 11 }}>
                      {draft.title.length}字
                    </span>
                  </label>
                  <label style={{ fontSize: 13, fontWeight: 600 }}>
                    封面副标题
                    <input
                      value={draft.subtitle}
                      onChange={(event) => update("subtitle", event.target.value)}
                      style={{ ...field, marginTop: 6 }}
                    />
                  </label>
                  <label style={{ fontSize: 13, fontWeight: 600 }}>
                    发布文案
                    <textarea
                      value={draft.caption}
                      onChange={(event) => update("caption", event.target.value)}
                      rows={5}
                      style={{ ...field, marginTop: 6 }}
                    />
                    <span style={{ float: "right", color: T.textFaint, fontSize: 11 }}>
                      {draft.caption.length}字，建议100–160字
                    </span>
                  </label>
                </div>
              </div>

              <div style={{ fontSize: 13, fontWeight: 600 }}>
                # 话题标签
                <input
                  value={draft.tagsText}
                  onChange={(event) => update("tagsText", event.target.value)}
                  style={{ ...field, marginTop: 6 }}
                  placeholder="#书籍名 #核心主题 #具体问题"
                />
                <span style={{ color: T.textFaint, fontSize: 11 }}>
                  空格分隔；书籍名标签为必选，其余AI标签均经过原文证据校验。
                </span>
                {kit.tags.some((item) => item.evidence) && (
                  <details
                    style={{
                      marginTop: 7,
                      color: T.textSoft,
                      fontSize: 11,
                      fontWeight: 400,
                    }}
                  >
                    <summary style={{ cursor: "pointer" }}>
                      查看标签与原文依据
                    </summary>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "max-content minmax(0, 1fr)",
                        gap: "4px 10px",
                        marginTop: 6,
                      }}
                    >
                      {kit.tags.map((item) => (
                        <div key={`${item.text}-${item.evidence}`} style={{ display: "contents" }}>
                          <span style={{ color: T.text }}>{item.text}</span>
                          <span>“{item.evidence}”</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>

              <label style={{ fontSize: 13, fontWeight: 600 }}>
                评论1 · 真诚转化
                <textarea
                  value={draft.conversionComment}
                  onChange={(event) =>
                    update("conversionComment", event.target.value)
                  }
                  rows={4}
                  style={{ ...field, marginTop: 6 }}
                />
              </label>

              <label style={{ fontSize: 13, fontWeight: 600 }}>
                评论2 · 购买路径
                <textarea
                  value={draft.purchaseComment}
                  onChange={(event) =>
                    update("purchaseComment", event.target.value)
                  }
                  rows={5}
                  style={{ ...field, marginTop: 6 }}
                />
              </label>

              <details
                style={{
                  border: `1px solid ${T.border}`,
                  borderRadius: 10,
                  padding: "10px 12px",
                }}
              >
                <summary
                  style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}
                >
                  完整文案 · {draft.fullScript.length}字
                </summary>
                <div style={{ color: T.textSoft, fontSize: 11, margin: "8px 0" }}>
                  此处修改仅用于导出TXT，不会同步到配音、字幕、分镜或成片。
                </div>
                <textarea
                  value={draft.fullScript}
                  onChange={(event) => update("fullScript", event.target.value)}
                  rows={14}
                  style={field}
                />
              </details>

            </div>
          )}
        </div>
      </div>
    </PanelShell>
  );
}

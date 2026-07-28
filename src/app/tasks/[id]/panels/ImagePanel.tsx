"use client";

import { useEffect, useRef, useState } from "react";
import { T, btn } from "../../../ui/theme";
import { advance, saveEdit, saveConfig, useArtifact, PanelShell, StepLoader, type PanelProps } from "./shared";
import { IMAGE_STYLES, DEFAULT_STYLE, imageStyle } from "@/lib/styles";

type Item = {
  beatId: number;
  sceneIds: number[];
  imagePath: string;
  baseImagePath?: string;
  prompt: string;
  visual: string;
  bookShowcase?: {
    kind: "recommendation" | "ending" | "recommendation-ending";
    triggerText: string;
    triggerSceneId?: number;
  };
};
type Images = { items: Item[] };
type ImageConfig = { style: string; ratio: string };

/** ⑦场景图 — 选画面风格 + 展示生图结果，可整体重绘，确认后进风格运镜 */
export function ImagePanel({ taskId, detail, reload, navigate }: PanelProps) {
  const read = useArtifact();
  const [d, setD] = useState<Images | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<Item | null>(null);
  const [imgCfg, setImgCfg] = useState<ImageConfig>({ style: DEFAULT_STYLE, ratio: "9:16" });
  const [regenBusy, setRegenBusy] = useState<number | null>(null); // 正在重生成的 beatId
  const [fb, setFb] = useState<Record<number, string>>({}); // 各图的修改反馈
  const [ver, setVer] = useState<Record<number, number>>({}); // 各图缓存版本(重生成后刷新)
  const [showBase, setShowBase] = useState<Record<number, boolean>>({});
  const [bookBusy, setBookBusy] = useState<number | null>(null);

  const status = detail.steps.find((s) => s.name === "imageGenerate")?.status;
  const done = status === "completed";
  const step = detail.steps.find((s) => s.name === "imageGenerate");

  useEffect(() => {
    read<ImageConfig>(taskId, "image-config.json").then((x) => x && setImgCfg((c) => ({ ...c, ...x })));
  }, [taskId, read]);

  // imgCfg 变化立即软保存（不重置步骤），刷新不丢
  const isFirstMount = useRef(true);
  useEffect(() => {
    if (isFirstMount.current) { isFirstMount.current = false; return; }
    saveConfig(taskId, "image-config.json", imgCfg);
  }, [taskId, imgCfg]);

  useEffect(() => {
    if (!["completed", "failed", "running"].includes(status ?? "")) return;
    read<Images>(taskId, "images.json").then((x) => x && setD(x));
  }, [status, taskId, read]);

  useEffect(() => {
    if (status === "completed" || status === "failed") setBusy(false);
  }, [status]);

  // 换风格重绘：先 saveEdit 写 image-config（重置 imageGenerate），再 run
  async function regen() {
    setBusy(true);
    try {
      const saved = await saveEdit(taskId, "image", imgCfg);
      if (!saved) throw new Error("保存生图配置失败");
      const r = await fetch(`/api/tasks/${taskId}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkpoint: "image" }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || "启动生图失败");
      reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : "启动生图失败");
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    setBusy(true);
    try {
      const ok = await advance(taskId, "style");
      if (!ok) throw new Error("进入风格运镜失败");
      reload();
      navigate("style");
    } catch (e) {
      alert(e instanceof Error ? e.message : "进入风格运镜失败");
    } finally {
      setBusy(false);
    }
  }

  // 补齐缺图:重跑 imageGenerate 步骤。因签名复用,已生成的图跳过,只补缺的那几张(幂等、不从头跑)。
  async function fillMissing() {
    setBusy(true);
    try {
      const r = await fetch(`/api/tasks/${taskId}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkpoint: "image" }),
      }).then((r) => r.json());
      if (!r.ok) alert(r.error || "补齐缺图失败,请重试");
    } catch {
      alert("补齐缺图请求失败,请检查网络后重试");
    } finally {
      reload();
      setBusy(false);
    }
  }

  // 手动重排：交换两张图的图片文件(imagePath)，但各自覆盖的句子(sceneIds)留在原位置不变。
  // 即"换图不换时段"——纠正九宫格模型偶发的放错格。写回 images.json(软保存,不重跑)。
  function swapImage(i: number, j: number) {
    if (!d || j < 0 || j >= d.items.length) return;
    const items = d.items.map((it) => ({ ...it }));
    const a = items[i], b = items[j];
    if (a.bookShowcase || b.bookShowcase) {
      alert("真实书籍展示位置请在分镜页面调整");
      return;
    }
    const tmpPath = a.imagePath, tmpPrompt = a.prompt, tmpVisual = a.visual;
    a.imagePath = b.imagePath; a.prompt = b.prompt; a.visual = b.visual;
    b.imagePath = tmpPath; b.prompt = tmpPrompt; b.visual = tmpVisual;
    const next = { ...d, items };
    setD(next);
    saveConfig(taskId, "images.json", next); // 软保存,不重置步骤
  }

  // 单图重生成:针对某一拍单独重画(可带修改反馈),不影响其余图。成功后刷新该图缓存。
  async function regenOne(beatId: number) {
    setRegenBusy(beatId);
    try {
      const r = await fetch(`/api/tasks/${taskId}/image/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beatId, feedback: fb[beatId] ?? "", style: imgCfg.style }),
      }).then((r) => r.json());
      if (r.ok) {
        if (d?.items.find((item) => item.beatId === beatId)?.bookShowcase) {
          await reapplyBook(beatId);
        } else {
          setVer((v) => ({ ...v, [beatId]: (v[beatId] ?? 0) + 1 })); // 缓存失效,强制重载
        }
        setFb((f) => ({ ...f, [beatId]: "" }));
      } else {
        alert(r.error || "重生成失败");
      }
    } catch {
      alert("重生成请求失败");
    } finally {
      setRegenBusy(null);
    }
  }

  async function reapplyBook(beatId: number) {
    setBookBusy(beatId);
    try {
      const r = await fetch(`/api/tasks/${taskId}/book-cover`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reapply: true }),
      }).then((response) => response.json());
      if (!r.ok) throw new Error(r.error || "重新应用封面失败");
      const next = await read<Images>(taskId, "images.json");
      if (next) setD(next);
      setVer((v) => ({ ...v, [beatId]: (v[beatId] ?? 0) + 1 }));
    } catch (error) {
      alert(error instanceof Error ? error.message : "重新应用封面失败");
    } finally {
      setBookBusy(null);
    }
  }

  const currentStyle = imageStyle(imgCfg.style);
  const imageGrid = d ? (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 12 }}>
      {d.items.map((it, idx) => {
        const displayPath =
          showBase[it.beatId] && it.baseImagePath ? it.baseImagePath : it.imagePath;
        return (
        <div
          key={it.beatId}
          style={{
            border: `2px solid ${it.bookShowcase ? T.accent : T.border}`,
            borderRadius: 10,
            overflow: "hidden",
            background: T.panelAlt,
          }}
          title={it.prompt}
        >
          {it.bookShowcase && (
            <div style={{ padding: "5px 7px", background: T.accentSoft, color: T.accent, fontSize: 11, fontWeight: 700 }}>
              📕 {it.bookShowcase.kind === "ending"
                ? "真实封面·结尾"
                : it.bookShowcase.kind === "recommendation-ending"
                  ? "真实封面·推荐与结尾"
                  : "真实封面·推荐段"}
            </div>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/tasks/${taskId}/file/${displayPath}?v=${ver[it.beatId] ?? 0}`}
            alt={`节拍 ${it.beatId}`}
            onClick={() => setZoom({ ...it, imagePath: displayPath })}
            style={{ width: "100%", aspectRatio: "9/16", objectFit: "cover", display: "block", cursor: "zoom-in", opacity: regenBusy === it.beatId ? 0.4 : 1 }}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 6px" }}>
            <button onClick={() => swapImage(idx, idx - 1)} disabled={idx === 0}
              title="与上一张换图" style={{ border: "none", background: "transparent", cursor: idx === 0 ? "default" : "pointer", color: idx === 0 ? T.textFaint : T.accent, fontSize: 14 }}>◀</button>
            <span style={{ fontSize: 11, color: T.textFaint }}>第 {it.beatId} 拍 · 句 {it.sceneIds.join(",")}</span>
            <button onClick={() => swapImage(idx, idx + 1)} disabled={idx === d.items.length - 1}
              title="与下一张换图" style={{ border: "none", background: "transparent", cursor: idx === d.items.length - 1 ? "default" : "pointer", color: idx === d.items.length - 1 ? T.textFaint : T.accent, fontSize: 14 }}>▶</button>
          </div>
          {/* 单图重生成:反馈框 + 按钮 */}
          <div style={{ display: "flex", gap: 4, padding: "0 6px 6px" }}>
            <input
              value={fb[it.beatId] ?? ""}
              onChange={(e) => setFb((f) => ({ ...f, [it.beatId]: e.target.value }))}
              placeholder="修改意见(可留空)"
              style={{ flex: 1, minWidth: 0, fontSize: 11, padding: "3px 6px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.panel, color: T.text }}
            />
            <button
              onClick={() => regenOne(it.beatId)}
              disabled={regenBusy !== null}
              title="按修改意见单独重画这一张"
              style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, cursor: regenBusy !== null ? "default" : "pointer", border: `1px solid ${T.border}`, background: T.panel, color: T.accent, whiteSpace: "nowrap" }}
            >
              {regenBusy === it.beatId ? "…" : "🔄重生成"}
            </button>
          </div>
          {it.bookShowcase && (
            <div style={{ padding: "0 6px 7px" }}>
              <div
                title={it.bookShowcase.triggerText}
                style={{ fontSize: 10, color: T.textFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 5 }}
              >
                触发口播：{it.bookShowcase.triggerText}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  onClick={() =>
                    setShowBase((value) => ({ ...value, [it.beatId]: !value[it.beatId] }))
                  }
                  style={{ ...btn("ghost"), padding: "3px 7px", fontSize: 10 }}
                >
                  {showBase[it.beatId] ? "查看封面版" : "查看原场景"}
                </button>
                <button
                  onClick={() => void reapplyBook(it.beatId)}
                  disabled={bookBusy !== null}
                  style={{ ...btn("ghost"), padding: "3px 7px", fontSize: 10 }}
                >
                  {bookBusy === it.beatId ? "处理中…" : "重新应用封面"}
                </button>
              </div>
            </div>
          )}
        </div>
        );
      })}
    </div>
  ) : null;

  return (
    <PanelShell
      title="⑦ 场景图"
      hint="选择画面风格后生成或重绘。每镜一张配图，确认后进风格运镜。"
      footer={
        <>
          <button onClick={regen} disabled={busy} style={btn("ghost")}>
            {busy ? "处理中…" : done ? "换风格重新生成" : "生成场景图"}
          </button>
          <button onClick={next} disabled={busy || !done} style={btn("primary")}>
            确认配图 →
          </button>
        </>
      }
    >
      {/* 画面风格选择器 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ color: T.textSoft, fontSize: 13, marginBottom: 8 }}>
          画面风格（当前：{currentStyle.label}）
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {IMAGE_STYLES.map((s) => {
            const on = imgCfg.style === s.key;
            return (
              <button
                key={s.key}
                onClick={() => setImgCfg({ ...imgCfg, style: s.key })}
                style={{
                  padding: "8px 14px", borderRadius: 8, cursor: "pointer",
                  border: `2px solid ${on ? T.accent : T.border}`,
                  background: on ? T.accentSoft : T.panel,
                  textAlign: "left", minWidth: 110,
                }}
              >
                <div style={{ fontWeight: 600, color: T.text, fontSize: 13 }}>{s.label}</div>
                <div style={{ fontSize: 11, color: T.textSoft, marginTop: 2 }}>{s.desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 生图结果 */}
      {status === "running" ? (
        <div>
          <StepLoader step={step} label="生成场景图" />
          {detail.progress?.imageGen && (() => {
            const p = detail.progress.imageGen;
            const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
            return (
              <div style={{ marginTop: 12, maxWidth: 340 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: T.text, marginBottom: 6 }}>
                  <span>🖼️ 已生成 {p.done} / {p.total} 张</span><span>{pct}%</span>
                </div>
                <div style={{ height: 8, background: T.border, borderRadius: 6, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: T.accent, transition: "width .4s" }} />
                </div>
                <div style={{ fontSize: 11, color: T.textFaint, marginTop: 4 }}>每 9 张一组出图,进度会分组跳动(真实已出图数)</div>
              </div>
            );
          })()}
          {imageGrid && (
            <div style={{ marginTop: 16 }}>
              <div style={{ color: T.textSoft, fontSize: 13, marginBottom: 8 }}>
                已落盘图片（生成未结束时先展示已有结果）
              </div>
              {imageGrid}
            </div>
          )}
        </div>
      ) : status === "failed" ? (
        // 生图部分失败(缺图):明确红字提示 + 一键补齐(只补缺的,已生成的不重画)
        <div style={{ border: `1px solid ${T.failed}`, borderRadius: 10, padding: "14px 16px", background: T.panelAlt }}>
          <div style={{ color: T.failed, fontWeight: 600, fontSize: 14, marginBottom: 6 }}>⚠️ 生图未全部完成</div>
          <div style={{ fontSize: 13, color: T.text, marginBottom: 10, lineHeight: 1.6 }}>
            {step?.error || "部分场景图生成失败(多为网络/接口超时)。"}
            <br />点下方按钮重试:<b>已生成的图会保留</b>,只补缺失的那几张。
          </div>
          <button onClick={fillMissing} disabled={busy} style={btn("primary")}>
            {busy ? "补齐中…" : "🔄 补齐缺图(只补缺的)"}
          </button>
          {imageGrid && (
            <div style={{ marginTop: 16 }}>
              <div style={{ color: T.textSoft, fontSize: 13, marginBottom: 8 }}>
                已保留 {d?.items.length ?? 0} 张，下面可以直接预览/调整；缺图补齐后会自动补上
              </div>
              {imageGrid}
            </div>
          )}
        </div>
      ) : !d ? (
        <p style={{ color: T.textSoft }}>选好风格后点「生成场景图」。</p>
      ) : (
        imageGrid
      )}

      {zoom && (
        <div
          onClick={() => setZoom(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(40,32,22,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, cursor: "zoom-out" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/tasks/${taskId}/file/${zoom.imagePath}`} alt="" style={{ maxHeight: "86vh", borderRadius: 12 }} />
        </div>
      )}
    </PanelShell>
  );
}

"use client";

import { useEffect, useState, use, useCallback } from "react";
import Link from "next/link";
import { CHECKPOINTS, lastStepOf } from "@/lib/checkpoints";
import { T, STATUS_COLOR, STATUS_LABEL } from "../../ui/theme";
import type { Detail } from "./panels/shared";
import { ParsePanel } from "./panels/ParsePanel";
import { TranscriptPanel } from "./panels/TranscriptPanel";
import { RewritePanel } from "./panels/RewritePanel";
import { BookPanel } from "./panels/BookPanel";
import { StoryboardPanel } from "./panels/StoryboardPanel";
import { TtsPanel } from "./panels/TtsPanel";
import { ImagePanel } from "./panels/ImagePanel";
import { StylePanel } from "./panels/StylePanel";
import { FinalPanel } from "./panels/FinalPanel";

/** 检查点状态:由其名下"最后一个内部 step"的状态推导;纯配置点看前序是否就绪 */
function checkpointStatus(detail: Detail, cpKey: string): string {
  const last = lastStepOf(cpKey);
  if (last) {
    const s = detail.steps.find((x) => x.name === last);
    return s?.status ?? "pending";
  }
  // 纯配置检查点(选书/风格):只要任务已开始就视为可进入
  return detail.task.status === "pending" ? "pending" : "ready";
}

export default function Workbench({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [active, setActive] = useState("parse");

  const load = useCallback(async () => {
    const r = await fetch(`/api/tasks/${id}`).then((r) => r.json());
    if (r.ok) setDetail(r);
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [load]);

  if (!detail)
    return <main style={{ padding: 40, color: T.textSoft }}>加载中…</main>;

  const panelProps = { taskId: id, detail, reload: load, navigate: setActive };

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      {/* 左侧导航 */}
      <aside
        style={{
          width: 240,
          background: T.sidebar,
          borderRight: `1px solid ${T.border}`,
          padding: "20px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          overflowY: "auto",
        }}
      >
        <Link
          href="/"
          style={{ color: T.textSoft, fontSize: 13, textDecoration: "none", marginBottom: 6 }}
        >
          ← 返回任务列表
        </Link>
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: T.text,
            padding: "8px 10px 12px",
            borderBottom: `1px solid ${T.border}`,
            marginBottom: 8,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={detail.task.title ?? ""}
        >
          {detail.task.title ?? "（待解析）"}
        </div>

        {CHECKPOINTS.filter((cp) => cp.key !== "book").map((cp, i) => {
          const st = checkpointStatus(detail, cp.key);
          const isActive = active === cp.key;
          const color =
            st === "ready" ? T.textSoft : STATUS_COLOR[st] ?? T.textFaint;
          return (
            <button
              key={cp.key}
              onClick={() => setActive(cp.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                borderRadius: 8,
                border: "none",
                background: isActive ? T.panel : "transparent",
                boxShadow: isActive ? `inset 3px 0 0 ${T.accent}` : "none",
                cursor: "pointer",
                textAlign: "left",
                color: T.text,
                fontSize: 14,
                fontWeight: isActive ? 600 : 400,
              }}
            >
              <span style={{ color, fontSize: 11 }}>●</span>
              <span style={{ color: T.textFaint, fontSize: 12, minWidth: 14 }}>
                {i + 1}
              </span>
              <span>{cp.label}</span>
            </button>
          );
        })}

        <div
          style={{
            marginTop: "auto",
            paddingTop: 16,
            borderTop: `1px solid ${T.border}`,
            fontSize: 12,
            color: T.textSoft,
          }}
        >
          累计成本 ¥{detail.totalCost.toFixed(3)}
          <div style={{ marginTop: 4, color: STATUS_COLOR[detail.task.status] }}>
            {STATUS_LABEL[detail.task.status] ?? detail.task.status}
          </div>
          {detail.task.error && (
            <div style={{ marginTop: 4, color: T.failed }}>{detail.task.error}</div>
          )}
        </div>
      </aside>

      {/* 右侧主面板 */}
      <main style={{ flex: 1, padding: "28px 36px", overflow: "hidden" }}>
        {active === "parse" && <ParsePanel {...panelProps} />}
        {active === "transcript" && <TranscriptPanel {...panelProps} />}
        {active === "rewrite" && <RewritePanel {...panelProps} />}
        {active === "book" && <BookPanel {...panelProps} />}
        {active === "storyboard" && <StoryboardPanel {...panelProps} />}
        {active === "tts" && <TtsPanel {...panelProps} />}
        {active === "image" && <ImagePanel {...panelProps} />}
        {active === "style" && <StylePanel {...panelProps} />}
        {active === "final" && <FinalPanel {...panelProps} />}
      </main>
    </div>
  );
}

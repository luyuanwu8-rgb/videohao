"use client";

import { useCallback, useEffect, useState } from "react";
import { T } from "../../../ui/theme";

/** 面板间共享的数据契约 */
export type StepRow = {
  name: string;
  status: string;
  error: string | null;
  cost: number;
  startedAt: number | null;
  endedAt: number | null;
};

export type Artifact = {
  filePath: string;
  fileType: string;
  stepName: string;
  version: number;
  tag: string | null;
  meta: Record<string, unknown> | null;
};

export type Detail = {
  ok: boolean;
  task: {
    id: string;
    title: string | null;
    status: string;
    track: string;
    sourceUrl: string | null;
    sourceMeta: Record<string, unknown> | null;
    error: string | null;
  };
  steps: StepRow[];
  artifacts?: Artifact[];
  totalCost: number;
};

export type PanelProps = {
  taskId: string;
  detail: Detail;
  /** 强制刷新 detail */
  reload: () => void;
  /** 跳转到指定检查点面板 */
  navigate: (key: string) => void;
};

/**
 * 步骤加载状态展示组件。
 * running → 转圈动画 + 已耗时
 * pending → 等待提示
 * failed  → 红色错误信息
 */
export function StepLoader({ step, label }: { step: StepRow | undefined; label: string }) {
  const [elapsed, setElapsed] = useState(0);
  const status = step?.status ?? "pending";
  const isRunning = status === "running";

  useEffect(() => {
    if (!isRunning) { setElapsed(0); return; }
    const start = step?.startedAt ? step.startedAt * 1000 : Date.now();
    setElapsed(Math.floor((Date.now() - start) / 1000));
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [isRunning, step?.startedAt]);

  if (status === "failed") {
    return (
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "20px 0", color: T.failed }}>
        <span style={{ fontSize: 20 }}>✗</span>
        <div>
          <div style={{ fontWeight: 600 }}>生成失败</div>
          {step?.error && <div style={{ fontSize: 13, marginTop: 4, opacity: 0.85 }}>{step.error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "28px 0" }}>
      {isRunning && (
        <span style={{
          width: 22, height: 22, borderRadius: "50%",
          border: `3px solid ${T.border}`,
          borderTopColor: T.accent,
          display: "inline-block",
          animation: "spin 0.9s linear infinite",
        }} />
      )}
      <div>
        <div style={{ color: T.text, fontSize: 15 }}>
          {isRunning ? `正在${label}…` : `等待${label}…`}
        </div>
        {isRunning && elapsed > 0 && (
          <div style={{ color: T.textSoft, fontSize: 12, marginTop: 4 }}>
            已用时 {elapsed >= 60 ? `${Math.floor(elapsed / 60)}分${elapsed % 60}秒` : `${elapsed}秒`}
          </div>
        )}
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

/** 读取任务目录下某产物 json */
export function useArtifact() {
  return useCallback(
    async <T,>(taskId: string, relPath: string): Promise<T | null> => {
      const r = await fetch(`/api/tasks/${taskId}/file/${relPath}`);
      if (!r.ok) return null;
      return (await r.json()) as T;
    },
    []
  );
}

/** 保存某检查点编辑后的产物 */
export async function saveEdit(
  taskId: string,
  checkpoint: string,
  data: unknown
): Promise<boolean> {
  const r = await fetch(`/api/tasks/${taskId}/edit`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checkpoint, data }),
  }).then((r) => r.json());
  return !!r.ok;
}

/** 软保存：把 data 写入任务目录下的 file，不重置步骤状态（用于持久化用户选项） */
export async function saveConfig(taskId: string, file: string, data: unknown): Promise<void> {
  await fetch(`/api/tasks/${taskId}/save-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, data }),
  });
}
export async function advance(taskId: string, checkpoint: string): Promise<boolean> {
  const r = await fetch(`/api/tasks/${taskId}/advance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checkpoint }),
  }).then((r) => r.json());
  return !!r.ok;
}

/** 面板通用容器:标题 + 说明 + 内容 + 底部操作条 */
export function PanelShell({
  title,
  hint,
  children,
  footer,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, margin: 0, color: T.text }}>{title}</h2>
        {hint && (
          <p style={{ color: T.textSoft, fontSize: 13, marginTop: 6 }}>{hint}</p>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{children}</div>
      {footer && (
        <div
          style={{
            borderTop: `1px solid ${T.border}`,
            paddingTop: 16,
            marginTop: 16,
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

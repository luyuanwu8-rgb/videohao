/**
 * 工作台配色 — 奶油暖色调(对标参考产品)。
 * 集中管理,各面板复用,避免散落的魔法色值。
 */
export const T = {
  // 背景层次
  bg: "#f5efe3", // 页面底色 奶油
  panel: "#fffdf8", // 卡片/面板 近白暖
  panelAlt: "#faf5ea", // 次级面板
  sidebar: "#efe7d6", // 左侧导航

  // 描边
  border: "#e3d8c2",
  borderStrong: "#d6c8ab",

  // 文字
  text: "#3a3128", // 主文字 深棕
  textSoft: "#7a6f5d", // 次要文字
  textFaint: "#a99d86", // 占位/弱

  // 主题强调(暖棕/赭石)
  accent: "#b07d3a", // 主按钮 赭石棕
  accentText: "#fffdf8",
  accentSoft: "#e9dcc2",

  // 状态色
  pending: "#a99d86",
  running: "#d99a2b",
  completed: "#6b8e4e",
  failed: "#c0563f",
  queued: "#8a7fb0",
  paused: "#6b9ab8",
} as const;

export const STATUS_COLOR: Record<string, string> = {
  pending: T.pending,
  running: T.running,
  completed: T.completed,
  failed: T.failed,
  skipped: T.textFaint,
  queued: T.queued,
  paused: T.paused,
};

export const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  skipped: "跳过",
  queued: "排队中",
  paused: "已暂停",
};

/** 通用按钮样式生成 */
export function btn(variant: "primary" | "ghost" = "primary"): React.CSSProperties {
  if (variant === "primary") {
    return {
      padding: "10px 22px",
      background: T.accent,
      border: "none",
      borderRadius: 8,
      color: T.accentText,
      fontWeight: 600,
      fontSize: 14,
      cursor: "pointer",
    };
  }
  return {
    padding: "7px 14px",
    background: "transparent",
    border: `1px solid ${T.borderStrong}`,
    borderRadius: 7,
    color: T.textSoft,
    fontSize: 13,
    cursor: "pointer",
  };
}

export const cardStyle: React.CSSProperties = {
  background: T.panel,
  border: `1px solid ${T.border}`,
  borderRadius: 12,
  padding: 20,
};

export const metadata = {
  title: "图书带货视频工厂 · 工作台",
  description: "抖音链接 → 逐字稿 → 改写 → 分镜 → 生图/配音 → 成片",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          fontFamily:
            "system-ui, -apple-system, 'Microsoft YaHei', sans-serif",
          background: "#f5efe3",
          color: "#3a3128",
        }}
      >
        {children}
      </body>
    </html>
  );
}

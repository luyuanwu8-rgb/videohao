/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@libsql/client", "libsql"],
  // 关闭 Next.js 开发模式左下角浮动 Dev Tools 图标（框架自带，与工作台无关）
  devIndicators: false,
};

export default nextConfig;

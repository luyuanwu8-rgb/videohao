/**
 * Provider 封装层。
 *
 * 每个外部服务一个文件，统一两点约定：
 *   1. 全部 mock-able —— mode==="mock" 时不发任何网络请求，返回占位产物。
 *   2. 业务逻辑只依赖这里导出的函数签名，不碰具体 SDK。
 *      将来 OpenAI→Gemini、StepFun→FishAudio、TikHub→自建，只改本目录。
 */

import { getConfig } from "@/lib/config-cache";

export type Mode = "mock" | "real";

/**
 * 读配置:优先内存缓存(api_configs 表,前端可编辑)→ 回退 process.env → 回退 fallback。
 * 缓存由 refreshConfigCache() 在流水线启动前预加载(同步读,不阻塞)。
 */
export function env(name: string, fallback = ""): string {
  return getConfig(name) ?? process.env[name] ?? fallback;
}

export function requireEnv(name: string): string {
  const v = getConfig(name) ?? process.env[name];
  if (!v) throw new Error(`missing config/env: ${name}`);
  return v;
}

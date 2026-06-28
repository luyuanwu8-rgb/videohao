/**
 * API 配置内存缓存。
 *
 * env() 是同步函数、被 provider 大量同步调用,不能逐次查库。
 * 所以把 api_configs 表预加载进内存 Map,env() 同步读 Map → 回退 process.env。
 * 在跑流水线前(runStep 开头)刷新一次;设置页写库后也刷新。
 *
 * 本模块不在顶层 import db(避免加载顺序/循环依赖),refresh 时动态 import。
 */

const cache = new Map<string, string>();
let loaded = false;

/** 同步读取一个配置值(命中库缓存返回值,否则 undefined 让 env 回退 process.env) */
export function getConfig(key: string): string | undefined {
  const v = cache.get(key);
  return v && v.length > 0 ? v : undefined;
}

/** 缓存是否已加载过(用于判断要不要首次刷新) */
export function isConfigLoaded(): boolean {
  return loaded;
}

/** 从 api_configs 表刷新缓存。写库后或流水线启动前调用。 */
export async function refreshConfigCache(): Promise<void> {
  try {
    const { db } = await import("@/db/client");
    const { apiConfigs } = await import("@/db/schema");
    const rows = await db.select().from(apiConfigs);
    cache.clear();
    for (const r of rows) {
      if (r.value && r.value.length > 0) cache.set(r.key, r.value);
    }
    loaded = true;
  } catch {
    // 库不可用(如建表前)不致命,env 会回退 process.env
  }
}

/** 确保缓存至少加载过一次(幂等,首次才真正查库) */
export async function ensureConfigLoaded(): Promise<void> {
  if (!loaded) await refreshConfigCache();
}

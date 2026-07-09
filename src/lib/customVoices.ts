import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TtsProvider, VoiceOption } from "@/lib/providers/voices";

/**
 * 用户自定义音色(前端可增删,存 data/custom-voices.json)。
 * 主要用于 Aura(MiniMax 复刻音色)——克隆新音色后在前端填 voice_id + 名称即可,无需改代码。
 * 带 provider 归属,将来火山/stepfun 也能自定义。
 */
export type CustomVoice = VoiceOption & { provider: TtsProvider };

/** 平台预置的克隆音色(文件不存在时作为初始数据)。用户可在前端增删,增删后以文件为准。 */
export const DEFAULT_CUSTOM_VOICES: CustomVoice[] = [
  { provider: "aurastd", id: "moss_audio_6b1797c8-2329-11f1-8c29-36c83b29da67", name: "王立群", group: "我的克隆", gender: "male" },
  { provider: "aurastd", id: "voice_8efe46f9-bc56-4ff3-a77b-aa8a5d50234d", name: "高晓松", group: "我的克隆", gender: "male" },
  { provider: "aurastd", id: "moss_audio_3a46bd2a-5b3b-11f1-938c-a6f6fa6b2a0c", name: "王树国", group: "我的克隆", gender: "male" },
];

const PATH = () => resolve(process.env.DATA_ROOT ?? "./data", "custom-voices.json");

/** 读自定义音色;文件不存在返回预置,格式异常返回预置(不影响主流程) */
export async function loadCustomVoices(): Promise<CustomVoice[]> {
  try {
    const raw = JSON.parse(await readFile(PATH(), "utf-8"));
    if (!Array.isArray(raw)) return DEFAULT_CUSTOM_VOICES;
    return raw.filter(isValidCustomVoice);
  } catch {
    return DEFAULT_CUSTOM_VOICES;
  }
}

/** 校验一条自定义音色(provider/id/name 必需,gender 归一) */
export function isValidCustomVoice(v: unknown): v is CustomVoice {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    (o.provider === "aurastd" || o.provider === "volcengine" || o.provider === "stepfun") &&
    typeof o.id === "string" && o.id.trim().length > 0 &&
    typeof o.name === "string" && o.name.trim().length > 0
  );
}

/** 规范化一条(去空格、gender 缺省 male、group 缺省"我的克隆") */
export function normalizeCustomVoice(v: CustomVoice): CustomVoice {
  return {
    provider: v.provider,
    id: v.id.trim(),
    name: v.name.trim(),
    group: (v.group ?? "").trim() || "我的克隆",
    gender: v.gender === "female" ? "female" : "male",
  };
}

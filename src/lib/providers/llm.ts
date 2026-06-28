import { env, requireEnv, type Mode } from "./base";

/**
 * 通用 LLM provider（改写/分析/分镜用）。
 *
 * OpenAI 兼容的 /chat/completions。通过环境变量切换任意厂商：
 *   LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
 * 例：DeepSeek、OpenAI、Kimi、通义、智谱…… 改 env 即可，业务代码不动。
 *
 * 这样可按成本自由选择模型，不绑定任何一家。
 */

export interface ChatResult {
  content: string;
  cost: number;
}

export async function chat(
  system: string,
  user: string,
  mode: Mode,
  opts?: { json?: boolean; temperature?: number }
): Promise<ChatResult> {
  if (mode === "mock") {
    // mock 下各 step 自己造结构化占位，这里仅回显
    return { content: user.slice(0, 200), cost: 0 };
  }

  const baseUrl = normalizeBaseUrl(env("LLM_BASE_URL", "https://api.deepseek.com"));
  const key = requireEnv("LLM_API_KEY");
  const model = env("LLM_MODEL", "deepseek-chat");

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: opts?.temperature ?? 0.7,
  };
  // 多数 OpenAI 兼容厂商支持 response_format=json_object
  if (opts?.json) {
    body.response_format = { type: "json_object" };
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LLM chat HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = json.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("LLM chat 返回空内容");

  // 粗略成本估算（按 token 数，单价由 env 可选配置；默认 0 不计费）
  const inTok = json.usage?.prompt_tokens ?? 0;
  const outTok = json.usage?.completion_tokens ?? 0;
  const priceIn = Number(env("LLM_PRICE_IN_PER_1K", "0"));
  const priceOut = Number(env("LLM_PRICE_OUT_PER_1K", "0"));
  const cost = (inTok / 1000) * priceIn + (outTok / 1000) * priceOut;

  return { content, cost };
}

/** 提取 JSON（容忍 ```json 包裹和前后噪声） */
export function extractJson(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  }
  const startObj = t.indexOf("{");
  const startArr = t.indexOf("[");
  const starts = [startObj, startArr].filter((x) => x >= 0);
  if (starts.length === 0) return t;
  const start = Math.min(...starts);
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  return t.slice(start, end + 1);
}

function normalizeBaseUrl(base: string): string {
  const b = (base || "").replace(/\/+$/, "");
  if (b.endsWith("/v1")) return b;
  return b ? `${b}/v1` : "";
}

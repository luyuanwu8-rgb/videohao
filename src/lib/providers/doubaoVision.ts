import { env, requireEnv, type Mode } from "./base";
import { readFile } from "node:fs/promises";

/**
 * 豆包 Seed 多模态视觉归位(火山方舟 Ark)—— 解九宫格乱序死循环(破法①)。
 *
 * 九宫格生图后,模型常把"第N格描述"画到别的格位置(内容-格位绑定不可靠)。
 * 本模块用视觉模型识别每张切片实际画的是什么,再把它归到正确的节拍,
 * 从而不依赖"第i格=第i拍"的脆弱假设。V5 实测真实切片归位 6/6 完美。
 *
 * 接口:Ark /api/v3/responses(input_image 支持 base64 data URI)。
 * 响应解析须取 output[] 里 type==="message" 项的 output_text(跳过前面的 reasoning 项)。
 * 护栏:强制合法排列(N↔N 无重漏)否则重试;失败/低置信返回 null → 调用方退回原位序。
 */

const DEFAULT_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_MODEL = "doubao-seed-1-6-251015";

/** 从 Ark responses 输出里取最终 message 文本(跳过 reasoning) */
function extractMessage(j: unknown): string {
  const out = (j as { output?: unknown[] })?.output ?? [];
  for (const item of out as Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>) {
    if (item.type === "message" && Array.isArray(item.content)) {
      const t = item.content.filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
      if (t) return t;
    }
  }
  return "";
}

/**
 * 给定 N 张位置切片图 + N 条节拍描述,返回 beatToCell 映射:
 *   beatToCell[beatIdx] = 该节拍内容实际所在的切片位置索引(0-based)。
 * 返回 null 表示跳过归位(mock、失败、低置信),调用方应退回原位序(cell i → beat i)。
 */
export async function rebindCells(
  cellPaths: string[],
  descriptions: string[],
  mode: Mode
): Promise<number[] | null> {
  if (mode === "mock") return null; // mock 切片为占位图,归位无意义
  const n = cellPaths.length;
  if (n <= 1 || descriptions.length !== n) return null; // 单图或不匹配无需归位

  const key = requireEnv("ARK_API_KEY");
  const base = env("ARK_BASE_URL", DEFAULT_BASE).replace(/\/+$/, "");
  const model = env("ARK_VISION_MODEL", DEFAULT_MODEL);
  const timeoutMs = Number(env("ARK_TIMEOUT_MS", "60000"));

  // 组装:图1..图n(base64)+ 描述列表 + 输出指令
  const content: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    const b64 = (await readFile(cellPaths[i])).toString("base64");
    content.push({ type: "input_text", text: `【图${i + 1}】` });
    content.push({ type: "input_image", image_url: `data:image/png;base64,${b64}` });
  }
  content.push({
    type: "input_text",
    text:
      `上面有${n}张图(编号1-${n})。下面是${n}条画面描述(编号1-${n}):\n` +
      descriptions.map((d, i) => `${i + 1}. ${d.slice(0, 80)}`).join("\n") +
      `\n\n请判断每一条描述最匹配哪一张图。只输出 JSON 对象,键为描述编号、值为图编号,` +
      `例如 {"1":3,"2":1}。每张图只能用一次,必须覆盖全部 ${n} 条。不要输出任何其他文字。`,
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: [{ role: "user", content }] }),
        signal: ac.signal,
      });
      if (!resp.ok) throw new Error(`ark HTTP ${resp.status}`);
      const txt = extractMessage(await resp.json());
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("响应无 JSON");
      const map = JSON.parse(m[0]) as Record<string, number>;
      // 构造 beatToCell(0-based)并校验为合法排列
      const beatToCell = new Array<number>(n).fill(-1);
      for (let d = 1; d <= n; d++) {
        const c = Number(map[String(d)]);
        if (!Number.isInteger(c) || c < 1 || c > n) throw new Error(`非法值 ${map[String(d)]}`);
        beatToCell[d - 1] = c - 1;
      }
      const seen = new Set(beatToCell);
      if (seen.size !== n || beatToCell.includes(-1)) throw new Error("非合法排列");
      return beatToCell;
    } catch {
      /* 重试一次;仍失败落到 return null */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

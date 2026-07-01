import { NextRequest } from "next/server";
import { getBufferedLogs, subscribeLogs, type LogRecord } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/tasks/[id]/logs — SSE 实时日志流(阶段0)。
 * 连接时先回放内存缓冲的历史日志,之后订阅新日志实时推送。
 * 客户端断开(req.signal abort)时清理订阅与心跳,防句柄泄漏。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (rec: LogRecord) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(rec)}\n\n`));
        } catch {
          /* 已关闭 */
        }
      };
      // 回放历史
      for (const rec of getBufferedLogs(id)) send(rec);
      // 订阅新日志
      const unsub = subscribeLogs(id, send);
      // 心跳保活(避免代理/浏览器超时断流)
      const hb = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* 已关闭 */
        }
      }, 15000);
      const close = () => {
        clearInterval(hb);
        unsub();
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      };
      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

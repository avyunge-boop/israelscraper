/**
 * צריכת SSE מ־POST /api/proxy-scan?stream=1
 */
import { consumeScanSseResponse, type ScanSseHandlers } from "@/lib/scan-sse-consume"

export async function consumeProxyScanStream(
  body: object,
  handlers: ScanSseHandlers
): Promise<{ ok: boolean; exitCode: number }> {
  const res = await fetch("/api/proxy-scan?stream=1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  })
  return consumeScanSseResponse(res, handlers)
}

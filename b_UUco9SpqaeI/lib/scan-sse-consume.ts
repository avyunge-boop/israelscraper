/**
 * Shared SSE consumer for scan streams (`type: log | progress | done | error`).
 */

export type ScanSseHandlers = {
  onLog?: (text: string) => void
  onProgress?: (p: Record<string, unknown>) => void
}

export async function consumeScanSseResponse(
  res: Response,
  handlers: ScanSseHandlers
): Promise<{ ok: boolean; exitCode: number; stderr?: string }> {
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(j.error ?? `סריקה נכשלה (${res.status})`)
  }
  const reader = res.body?.getReader()
  if (!reader) throw new Error("אין גוף תשובה מהשרת")
  const decoder = new TextDecoder()
  let buffer = ""
  let done: { ok?: boolean; exitCode?: number; stderr?: string } | null = null
  while (true) {
    const { value, done: streamDone } = await reader.read()
    if (streamDone) break
    buffer += decoder.decode(value, { stream: true })
    buffer = buffer.replace(/\r\n/g, "\n")
    const parts = buffer.split("\n\n")
    buffer = parts.pop() ?? ""
    for (const block of parts) {
      const line = block.trim()
      if (!line.startsWith("data:")) continue
      const jsonStr = line.startsWith("data: ")
        ? line.slice(6)
        : line.replace(/^data:\s*/, "")
      if (!jsonStr) continue
      let j: Record<string, unknown>
      try {
        j = JSON.parse(jsonStr) as Record<string, unknown>
      } catch {
        continue
      }
      if (j.type === "log" && typeof j.text === "string") {
        handlers.onLog?.(j.text)
      }
      if (j.type === "progress" && j.payload && typeof j.payload === "object") {
        handlers.onProgress?.(j.payload as Record<string, unknown>)
      }
      if (j.type === "done") {
        done = j as { ok?: boolean; exitCode?: number; stderr?: string }
      }
      if (j.type === "error") {
        throw new Error(String(j.message ?? "Stream error"))
      }
    }
  }
  if (!done) throw new Error("הזרימה נקטעה לפני סיום")
  if (!done.ok) {
    const hint = (done.stderr ?? "").trim().slice(-400)
    throw new Error(
      `האורקסטרטור יצא עם קוד ${done.exitCode ?? "?"}${hint ? `\n${hint}` : ""}`
    )
  }
  return { ok: true, exitCode: done.exitCode ?? 0, stderr: done.stderr }
}

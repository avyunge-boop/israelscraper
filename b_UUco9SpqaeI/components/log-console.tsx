"use client"

import { useEffect, useRef } from "react"
import { Terminal } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface LogConsoleProps {
  lines: string[]
  title: string
  emptyHint?: string
}

export function LogConsole({ lines, title, emptyHint }: LogConsoleProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [lines.length])

  if (lines.length === 0 && !emptyHint) return null

  return (
    <Card className="border-border/60 font-mono text-xs">
      <CardHeader className="py-3 pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Terminal className="size-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div
          className="max-h-[min(24rem,50vh)] overflow-y-auto rounded-md bg-muted/40 p-3 whitespace-pre-wrap break-words text-muted-foreground"
          dir="ltr"
        >
          {lines.length === 0 ? (
            <span className="opacity-60">{emptyHint}</span>
          ) : (
            lines.map((line, i) => (
              <div key={`log-line-${i}`}>{line}</div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </CardContent>
    </Card>
  )
}

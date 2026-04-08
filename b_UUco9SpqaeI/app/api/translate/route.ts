import Groq from "groq-sdk"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const MODEL = "llama-3.1-8b-instant"

const SYSTEM =
  "You translate Hebrew public transport alerts and summaries into clear, concise English. " +
  "Output only the translation. No quotation marks, labels, or preamble."

export async function POST(request: Request) {
  const apiKey = process.env.GROQ_API_KEY?.trim()
  if (!apiKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY is not configured" },
      { status: 500 }
    )
  }

  let body: { text?: string }
  try {
    body = (await request.json()) as { text?: string }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 })
  }
  if (text.length > 12_000) {
    return NextResponse.json({ error: "text is too long" }, { status: 400 })
  }

  try {
    const groq = new Groq({ apiKey })
    const model = process.env.GROQ_MODEL?.trim() || MODEL
    const completion = await groq.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 1024,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
    })
    const out = completion.choices[0]?.message?.content?.trim() ?? ""
    if (!out) {
      return NextResponse.json(
        { error: "Empty model response" },
        { status: 502 }
      )
    }
    return NextResponse.json({ translation: out })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}

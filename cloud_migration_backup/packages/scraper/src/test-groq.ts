/**
 * בדיקת חיבור Groq מהטרמינל (מפתח מ־.env בשורש ה-repo).
 * הרצה: pnpm --filter @workspace/scripts run test-groq
 */
import { loadRootEnv } from "./repo-paths";

const MODEL = "llama-3.1-8b-instant";

loadRootEnv();

async function main() {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) {
    console.error("Missing GROQ_API_KEY in repo-root .env");
    process.exit(1);
  }
  const model = process.env.GROQ_MODEL?.trim() || MODEL;
  console.log("Using model:", model);
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      temperature: 0,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    }),
  });
  const json = (await res.json()) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (!res.ok) {
    console.error("HTTP", res.status, json.error?.message ?? json);
    process.exit(1);
  }
  const text = json.choices?.[0]?.message?.content?.trim() ?? "";
  console.log("Response:", text);
  if (!text) {
    console.error("Empty completion");
    process.exit(1);
  }
  console.log("Groq OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

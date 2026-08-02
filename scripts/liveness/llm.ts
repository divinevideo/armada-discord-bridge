/**
 * LLM text generation for persona messages, via the Anthropic Messages API
 * (ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY from the environment, so it works
 * against a local proxy or the real API unchanged). Only `text` content blocks
 * are read; thinking blocks some proxies emit are ignored.
 */

const MODEL = process.env.LIVENESS_MODEL?.trim() || "claude-haiku-4-5-20251001";

export async function generate(system: string, user: string): Promise<string> {
  const base = process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`llm: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (body.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("llm: empty response");
  // Strip wrapping quotes / a leading "handle:" a model sometimes adds.
  // Em/en dashes are enforced away in code — the prompt bans them but the
  // model ignores that often enough. Digit ranges keep a plain hyphen;
  // everything else becomes a comma, which is how casual chat actually reads.
  return text
    .replace(/^["“](.*)["”]$/s, "$1")
    .replace(/^@?[\w-]{2,20}:\s+/, "")
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2")
    .replace(/\s*[—–]+\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/^,\s*/, "")
    .trim();
}

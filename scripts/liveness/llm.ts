/**
 * LLM text generation for persona messages, via the Anthropic Messages API
 * (ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY from the environment, so it works
 * against a local proxy or the real API unchanged). Only `text` content blocks
 * are read; thinking blocks some proxies emit are ignored.
 */

const MODEL = process.env.LIVENESS_MODEL?.trim() || "claude-haiku-4-5-20251001";

function apiBaseKey(): { base: string; key: string } {
  const base = process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  return { base, key };
}

/**
 * One-word POST / SKIP verdicts that gate every repost. A vision call judges
 * an image; a text call judges a link by its title. Each rubric is built for a
 * lane (bare meme, content image, external link) around the source `subject`.
 * All throw on API error; callers treat any failure as SKIP, so nothing
 * unvetted goes out.
 */
async function visionVerdict(url: string, rubric: string): Promise<boolean> {
  const { base, key } = apiBaseKey();
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url } },
            { type: "text", text: rubric },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`vet: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return readVerdict(await res.json());
}

async function textVerdict(instruction: string): Promise<boolean> {
  const { base, key } = apiBaseKey();
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8,
      messages: [{ role: "user", content: instruction }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`vet: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return readVerdict(await res.json());
}

function readVerdict(body: unknown): boolean {
  const blocks = (body as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim()
    .toUpperCase()
    .startsWith("POST");
}

const memeRubric = (subject: string): string =>
  `You curate memes for an online community about ${subject}. Look at this image ` +
  "and answer with ONE word only:\n" +
  `POST - it is a real, self-explanatory meme, clearly about ${subject}, and it ` +
  "lands on its own with NO caption.\n" +
  "SKIP - it is off-topic, low-effort, confusing without a caption, not actually " +
  "a meme (e.g. a plain photo, screenshot, or announcement), or unsafe.\n" +
  "When unsure, answer SKIP. One word: POST or SKIP.";

const mediaRubric = (subject: string): string =>
  `You curate a channel about ${subject}. Look at this image and answer with ONE ` +
  "word only:\n" +
  `POST - it is a high-quality, genuinely interesting image clearly about ${subject}: ` +
  "a striking photo, screenshot, artwork, or infographic worth sharing on its own.\n" +
  "SKIP - it is off-topic, low quality, a low-effort meme, a personal selfie, " +
  "promotional spam, or unsafe.\n" +
  "When unsure, answer SKIP. One word: POST or SKIP.";

const linkRubric = (subject: string): string =>
  `You curate a channel about ${subject}. Judging only by a link's title, answer ` +
  "with ONE word only:\n" +
  `POST - it is a substantive, on-topic resource about ${subject}: news, an ` +
  "article, a guide, a study, a video, or a notable release.\n" +
  "SKIP - it is a personal anecdote, a question, a low-effort post, a meme, " +
  "product spam, or off-topic.\n" +
  "When unsure, answer SKIP. One word: POST or SKIP.";

/** Appends a community's hard exclusion rule (e.g. no competitor promotion). */
const withAvoid = (rubric: string, avoid?: string): string =>
  avoid ? `${rubric}\n\nHARD RULE, overrides the above: answer SKIP if ${avoid}` : rubric;

/** Bare meme image: must be a self-explanatory on-`subject` meme. */
export const judgeMeme = (url: string, subject: string, avoid?: string): Promise<boolean> =>
  visionVerdict(url, withAvoid(memeRubric(subject), avoid));
/** Content image (posted with its title): high-quality and on-`subject`. */
export const judgeMedia = (url: string, subject: string, avoid?: string): Promise<boolean> =>
  visionVerdict(url, withAvoid(mediaRubric(subject), avoid));
/** External link (posted with its title): substantive and on-`subject`. */
export const judgeLink = (title: string, subject: string, avoid?: string): Promise<boolean> =>
  textVerdict(`${withAvoid(linkRubric(subject), avoid)}\n\nTITLE: "${title}"`);

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

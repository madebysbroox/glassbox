import Anthropic from "@anthropic-ai/sdk";
import { Guard } from "./guard";
import { checkPass, issuePass, verifyTurnstile } from "./pass";

export { Guard };

export interface Env {
  ANTHROPIC_API_KEY: string;
  // Only set for local testing against test/mock-anthropic.mjs.
  ANTHROPIC_BASE_URL?: string;
  GUARD: DurableObjectNamespace<Guard>;
  DAILY_CAP_USD: string;
  HOURLY_LIMIT: string;
  // Turnstile is skipped until both of these are set.
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

const MODEL = "claude-haiku-5-5";
const MAX_PROMPT_CHARS = 140;
const MAX_TURNS = 10;
const MAX_TOKENS = 400;
// Assistant turns come back from the browser, so cap them too.
const MAX_ASSISTANT_CHARS = 4000;
// USD per token for Claude Haiku 5.5 (prompts under 100K tokens).
const PRICE_IN = 0.1 / 1e6;
const PRICE_OUT = 0.5 / 1e6;

const SYSTEM =
  "You are the engine inside Glassbox, a website that shows people how a request to a language model travels and gets answered. " +
  "Visitors type short messages of up to 140 characters. Answer helpfully and briefly: a few sentences, plain text, no markdown headings.";

type Turn = { role: "user" | "assistant"; content: string };
type Send = (event: string, data: Record<string, unknown>) => Promise<void>;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/config") {
      return Response.json({ turnstile_site_key: turnstileOn(env) ? env.TURNSTILE_SITE_KEY : null });
    }
    if (url.pathname === "/api/chat") {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return chat(req, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};

async function chat(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const received = Date.now();

  let turns: Turn[];
  let body: { messages?: unknown; pass?: unknown; turnstile_token?: unknown };
  try {
    body = await req.json();
    turns = validate(body.messages);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const ip = req.headers.get("cf-connecting-ip") ?? "local";

  // A valid pass means this visitor already solved Turnstile within the hour.
  let newPass: string | null = null;
  if (turnstileOn(env) && !(await checkPass(env.TURNSTILE_SECRET_KEY!, body.pass, received))) {
    if (!(await verifyTurnstile(env.TURNSTILE_SECRET_KEY!, body.turnstile_token, ip))) {
      return Response.json({ error: "Please complete the quick human check first.", need_check: true }, { status: 403 });
    }
    newPass = await issuePass(env.TURNSTILE_SECRET_KEY!, received);
  }

  const guard = env.GUARD.get(env.GUARD.idFromName("global"));
  const admission = await guard.admit(ip, received, Number(env.HOURLY_LIMIT), Number(env.DAILY_CAP_USD));
  if (!admission.ok) {
    const error =
      admission.reason === "cap"
        ? "Out of fuel for today. Glassbox refuels at midnight UTC."
        : `That's ${env.HOURLY_LIMIT} messages this hour. Come back a little later.`;
    return Response.json({ error }, { status: 429 });
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send: Send = (event, data) =>
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const record = (costUsd: number) => guard.record(costUsd, Date.now());
  ctx.waitUntil(relay(turns, env, received, newPass, send, record).finally(() => writer.close()));

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    },
  });
}

function validate(messages: unknown): Turn[] {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("messages must be a non-empty array");
  const turns = messages.map((m, i): Turn => {
    const role = i % 2 === 0 ? "user" : "assistant";
    if (!m || typeof m !== "object" || (m as Turn).role !== role || typeof (m as Turn).content !== "string") {
      throw new Error(`message ${i} must be a ${role} turn with string content`);
    }
    const content = (m as Turn).content;
    if (role === "user" && (content.trim().length === 0 || [...content].length > MAX_PROMPT_CHARS)) {
      throw new Error(`each message must be 1 to ${MAX_PROMPT_CHARS} characters`);
    }
    if (role === "assistant" && content.length > MAX_ASSISTANT_CHARS) throw new Error("assistant turn too long");
    return { role, content };
  });
  if (turns.at(-1)!.role !== "user") throw new Error("the last message must be from the user");
  if ((turns.length + 1) / 2 > MAX_TURNS) throw new Error(`conversations are limited to ${MAX_TURNS} messages`);
  return turns;
}

async function relay(
  turns: Turn[],
  env: Env,
  received: number,
  pass: string | null,
  send: Send,
  record: (costUsd: number) => Promise<number>,
): Promise<void> {
  await send("relay_received", { server_time: received, ...(pass && { pass }) });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined });
  const dispatched = Date.now();
  await send("dispatched", { ms: dispatched - received });

  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null = null;
  let firstTextMs: number | null = null;

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      output_config: { effort: "low" },
      messages: turns,
    });

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          inputTokens = event.message.usage.input_tokens;
          await send("accepted", { input_tokens: inputTokens, ms: Date.now() - dispatched });
          break;
        case "content_block_start":
          if (event.content_block.type === "thinking") await send("thinking", { ms: Date.now() - dispatched });
          break;
        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            firstTextMs ??= Date.now() - dispatched;
            await send("text", { text: event.delta.text, est_tokens: Math.max(1, Math.round(event.delta.text.length / 4)) });
          }
          break;
        case "message_delta":
          outputTokens = event.usage.output_tokens;
          stopReason = event.delta.stop_reason;
          break;
      }
    }

    const cost = inputTokens * PRICE_IN + outputTokens * PRICE_OUT;
    await record(cost);
    await send("done", {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      stop_reason: stopReason,
      cost_usd: cost,
      first_text_ms: firstTextMs,
      total_ms: Date.now() - received,
    });
  } catch (err) {
    console.error(err);
    let reason = "The engine stalled. Try again in a moment.";
    if (err instanceof Anthropic.RateLimitError) reason = "The engine is busy. Try again in a minute.";
    else if (err instanceof Anthropic.AuthenticationError) reason = "The relay is misconfigured (bad API key).";
    else if (err instanceof Anthropic.BadRequestError) reason = "The API rejected that request.";
    await send("error", { reason });
  }
}

function turnstileOn(env: Env): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

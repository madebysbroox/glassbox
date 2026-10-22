import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";

export interface Env {
  ANTHROPIC_API_KEY: string;
  // Only set for local testing against test/mock-anthropic.mjs.
  ANTHROPIC_BASE_URL?: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;
  // Signs the session cookie handed out after a Turnstile check.
  SESSION_SECRET: string;
  DAILY_CAP_USD: string;
  CHAT_LIMITER: RateLimit;
  BUDGET: DurableObjectNamespace<Budget>;
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
const SESSION_COOKIE = "gb_session";
const SESSION_SECONDS = 60 * 60;

const SYSTEM =
  "You are the engine inside Glassbox, a website that shows people how a request to a language model travels and gets answered. " +
  "Visitors type short messages of up to 140 characters. Answer helpfully and briefly: a few sentences, plain text, no markdown headings.";

type Turn = { role: "user" | "assistant"; content: string };

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/config") return Response.json({ turnstile_site_key: env.TURNSTILE_SITE_KEY });
    if (url.pathname === "/api/session") {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return session(req, env);
    }
    if (url.pathname === "/api/chat") {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return chat(req, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};

// Daily spend across all visitors. One instance, keyed by UTC date.
export class Budget extends DurableObject<Env> {
  async spentToday(): Promise<number> {
    return (await this.ctx.storage.get<number>(today())) ?? 0;
  }

  async add(usd: number): Promise<void> {
    const key = today();
    const spent = ((await this.ctx.storage.get<number>(key)) ?? 0) + usd;
    const old = [...(await this.ctx.storage.list()).keys()].filter((k) => k !== key);
    if (old.length) await this.ctx.storage.delete(old);
    await this.ctx.storage.put(key, spent);
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function budget(env: Env) {
  return env.BUDGET.get(env.BUDGET.idFromName("global"));
}

// Verifies a Turnstile token and swaps it for a signed cookie, so visitors solve one check per hour, not per message.
async function session(req: Request, env: Env): Promise<Response> {
  let token: unknown;
  try {
    ({ token } = (await req.json()) as { token?: unknown });
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof token !== "string" || !token) return Response.json({ error: "missing token" }, { status: 400 });

  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  const ip = req.headers.get("cf-connecting-ip");
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const outcome = (await res.json()) as { success: boolean };
  if (!outcome.success) return Response.json({ error: "The human check failed. Reload and try again." }, { status: 403 });

  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const value = `${expires}.${await sign(String(expires), env.SESSION_SECRET)}`;
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return Response.json(
    { ok: true },
    { headers: { "set-cookie": `${SESSION_COOKIE}=${value}; Path=/api; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Strict${secure}` } },
  );
}

async function hasSession(req: Request, env: Env): Promise<boolean> {
  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=(\\d+)\\.([0-9a-f]+)`));
  if (!match) return false;
  const [, expires, mac] = match;
  if (Number(expires) < Date.now() / 1000) return false;
  return (await sign(expires, env.SESSION_SECRET)) === mac;
}

async function sign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function chat(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const received = Date.now();

  if (!(await hasSession(req, env))) {
    return Response.json({ error: "Checking you're human first.", challenge: true }, { status: 401 });
  }
  const { success } = await env.CHAT_LIMITER.limit({ key: req.headers.get("cf-connecting-ip") ?? "unknown" });
  if (!success) return Response.json({ error: "Slow down a little. Try again in a minute." }, { status: 429 });
  if ((await budget(env).spentToday()) >= Number(env.DAILY_CAP_USD)) {
    return Response.json({ error: "Glassbox has used up today's budget. Come back tomorrow." }, { status: 503 });
  }

  let turns: Turn[];
  try {
    const body = (await req.json()) as { messages?: unknown };
    turns = validate(body.messages);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event: string, data: Record<string, unknown>) =>
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  ctx.waitUntil(relay(turns, env, received, send).finally(() => writer.close()));

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
  send: (event: string, data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  await send("relay_received", { server_time: received });

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
    await budget(env).add(cost);
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

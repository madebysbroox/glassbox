# Glassbox

A chat page where every message (140 characters max) goes to Claude Haiku 5.5 through a small Cloudflare Worker, and the page shows what happened on the way: tokens in and out, the thinking tokens that were billed but never shown, time to first token, cost, and a millisecond log of each leg.

Phases 2 and 4 of the design doc are in: plain chat plus counters, and bot protection with a daily cap. The animated strip and ads come next.

## Protection

- **Turnstile.** The page runs an invisible Cloudflare Turnstile check (it only shows a checkbox if Cloudflare is unsure). `/api/session` verifies the token and sets a signed `gb_session` cookie for an hour; `/api/chat` refuses requests without it.
- **Rate limit.** At most 6 messages a minute per IP address (`CHAT_LIMITER` in `wrangler.jsonc`).
- **Daily cap.** A Durable Object (`Budget`) adds up the cost of every answer per UTC day. Once it reaches `DAILY_CAP_USD` (default $1.00), the relay stops calling the API until midnight UTC. One answer can take it slightly over.

## Layout

- `src/worker.ts`: the relay. It holds the API key, checks limits (140 characters, 10 turns, 400 output tokens), calls the API with streaming, and sends its own timed events to the page over SSE.
- `public/`: the static page (`index.html`, `style.css`, `app.js`). No framework, no build step.
- `test/mock-anthropic.mjs`: a fake Messages API that streams a canned answer, so you can run everything without a key.

## Run it locally with the mock (no API key, no cost)

```sh
npm install
printf 'ANTHROPIC_API_KEY=mock-key\nANTHROPIC_BASE_URL=http://localhost:8788\nTURNSTILE_SITE_KEY=1x00000000000000000000AA\nTURNSTILE_SECRET=1x0000000000000000000000000000000AA\nSESSION_SECRET=local-dev-secret\n' > .dev.vars
npm run mock      # terminal 1
npm run dev       # terminal 2, then open http://localhost:8787
```

Type a message containing "refuse" to see how a refusal looks.

## Run it locally against the real API

Put your key in `.dev.vars` in place of the mock lines (keep the Turnstile test keys and session secret, which always pass locally):

```sh
printf 'ANTHROPIC_API_KEY=sk-ant-...\nTURNSTILE_SITE_KEY=1x00000000000000000000AA\nTURNSTILE_SECRET=1x0000000000000000000000000000000AA\nSESSION_SECRET=local-dev-secret\n' > .dev.vars
npm run dev
```

## Deploy

Before deploying, set a monthly spend limit in the Anthropic Console (the design doc suggests $30).

Create a Turnstile widget for your workers.dev hostname (Cloudflare dashboard, Turnstile, Add widget, mode Managed), put its site key in `TURNSTILE_SITE_KEY` in `wrangler.jsonc`, then:

```sh
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put TURNSTILE_SECRET        # the widget's secret key
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
npm run deploy
```

Wrangler prints the live URL, something like `https://glassbox.<your-subdomain>.workers.dev`.

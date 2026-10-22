# Glassbox

A chat page where every message (140 characters max) goes to Claude Haiku 5.5 through a small Cloudflare Worker, and the page shows what happened on the way: tokens in and out, the thinking tokens that were billed but never shown, time to first token, cost, and a millisecond log of each leg.

A strip under the chat animates each leg as it happens: grey packets out to the relay and on to the API, the engine pulsing while the model thinks, and blue packets streaming back. Every movement is triggered by a real event from the relay.

Guard rails: 140 characters a message, 10 turns a conversation, 400 output tokens an answer, 20 messages per IP per hour, a $2 daily spend cap (resets at midnight UTC), and an optional Cloudflare Turnstile bot check. Ads come next.

## Layout

- `src/worker.ts`: the relay. It holds the API key, checks limits (140 characters, 10 turns, 400 output tokens), calls the API with streaming, and sends its own timed events to the page over SSE.
- `src/guard.ts`: a Durable Object that counts messages per IP and the day's spend.
- `src/pass.ts`: Turnstile verification and the signed one-hour pass a visitor gets after solving it once.
- `public/`: the static page (`index.html`, `style.css`, `app.js`, `strip.js`). No framework, no build step.
- `test/mock-anthropic.mjs`: a fake Messages API that streams a canned answer, so you can run everything without a key.

## Run it locally with the mock (no API key, no cost)

```sh
npm install
printf 'ANTHROPIC_API_KEY=mock-key\nANTHROPIC_BASE_URL=http://localhost:8788\n' > .dev.vars
npm run mock      # terminal 1
npm run dev       # terminal 2, then open http://localhost:8787
```

Type a message containing "refuse" to see how a refusal looks.

## Run it locally against the real API

Put only your key in `.dev.vars` (no base URL line):

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .dev.vars
npm run dev
```

## Deploy

Before deploying, set a monthly spend limit in the Anthropic Console (the design doc suggests $30). There is no bot protection or daily cap yet, so don't share the link widely until phase 4.

```sh
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

Wrangler prints the live URL, something like `https://glassbox.<your-subdomain>.workers.dev`.

The limits live in `wrangler.jsonc` under `vars` (`DAILY_CAP_USD`, `HOURLY_LIMIT`). Change them there and redeploy.

## Turn on the bot check (Turnstile)

1. In the Cloudflare dashboard, open **Turnstile** and click **Add widget**. Name it `glassbox`, add your workers.dev hostname, and leave the mode on **Managed**.
2. Paste the **site key** into `TURNSTILE_SITE_KEY` in `wrangler.jsonc`. It's public, so it's fine in the repo.
3. Run `npx wrangler secret put TURNSTILE_SECRET_KEY` and paste the **secret key**.
4. Run `npm run deploy`.

Until both keys are set, the check is skipped and everything else still works.

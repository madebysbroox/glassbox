# Glassbox

A chat page where every message (140 characters max) goes to Claude Haiku 5.5 through a small Cloudflare Worker, and the page shows what happened on the way: tokens in and out, the thinking tokens that were billed but never shown, time to first token, cost, and a millisecond log of each leg.

This is phase 2 of the design doc: plain chat plus counters. The animated strip, bot protection and ads come next.

## Layout

- `src/worker.ts`: the relay. It holds the API key, checks limits (140 characters, 10 turns, 400 output tokens), calls the API with streaming, and sends its own timed events to the page over SSE.
- `public/`: the static page (`index.html`, `style.css`, `app.js`). No framework, no build step.
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

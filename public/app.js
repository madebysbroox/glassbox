import * as strip from "/strip.js";

const MAX_TURNS = 10;

const $ = (id) => document.getElementById(id);
const form = $("composer");
const input = $("prompt");
const sendBtn = $("send");
const convo = $("conversation");
const log = $("log");

let history = [];
let sessionCost = 0;
let busy = false;
// Bot check: a Turnstile token for the first message, then the relay's signed pass.
let pass = null;
let turnstileToken = null;
let turnstileWidget = null;

setupCheck();

input.addEventListener("input", () => {
  $("chars").textContent = 140 - [...input.value].length;
});

$("reset").addEventListener("click", () => {
  if (busy) return;
  history = [];
  sessionCost = 0;
  convo.replaceChildren();
  log.replaceChildren();
  for (const id of ["c-in", "c-out", "c-burn", "c-first", "c-cost"]) $(id).textContent = "–";
  $("c-session").textContent = usd(0);
  updateTurns();
  input.focus();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy || userTurns() >= MAX_TURNS) return;

  busy = true;
  sendBtn.disabled = true;
  input.value = "";
  $("chars").textContent = 140;
  history.push({ role: "user", content: text });
  bubble("user", text);
  const answer = bubble("assistant", "");
  log.replaceChildren();

  try {
    const reply = await ask(answer);
    if (reply) history.push({ role: "assistant", content: reply });
    else history.pop();
  } catch (err) {
    history.pop();
    answer.remove();
    bubble("error", "Lost the connection to the relay. Try again.");
    logLine(0, `error: ${err.message}`);
  }

  busy = false;
  sendBtn.disabled = userTurns() >= MAX_TURNS;
  updateTurns();
  input.focus();
});

async function ask(answer) {
  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);
  let reply = "";
  let estVisible = 0;

  const payload = JSON.stringify({ messages: history, pass, turnstile_token: pass ? undefined : turnstileToken });
  const estTokens = Math.round(payload.length / 4);
  let tReceived = 0;

  logLine(0, "request leaves your browser");
  strip.sendOut(estTokens);
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  if (!res.ok || !res.body) {
    const { error, need_check } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (need_check) resetCheck();
    answer.remove();
    bubble("error", error);
    logLine(since(), `relay refused: ${error}`);
    strip.finished();
    return null;
  }

  for await (const { event, data } of sse(res.body)) {
    switch (event) {
      case "relay_received":
        if (data.pass) {
          pass = data.pass;
          turnstileToken = null;
          $("check").hidden = true;
        }
        tReceived = since();
        logLine(tReceived, "relay received it");
        break;
      case "dispatched":
        strip.dispatch(estTokens, tReceived);
        logLine(since(), "relay sent it to the Anthropic API");
        break;
      case "accepted":
        $("c-in").textContent = data.input_tokens;
        strip.accepted(data.input_tokens, data.ms);
        logLine(since(), `API accepted ${data.input_tokens} input tokens (${data.ms} ms from relay)`);
        break;
      case "thinking":
        strip.thinking();
        logLine(since(), "engine is thinking");
        break;
      case "text":
        strip.inbound();
        if (!reply) logLine(since(), "first words arrive");
        reply += data.text;
        estVisible += data.est_tokens;
        answer.textContent = reply;
        $("c-out").textContent = `~${estVisible}`;
        break;
      case "done": {
        const burned = Math.max(0, data.output_tokens - estVisible);
        $("c-out").textContent = data.output_tokens;
        $("c-burn").textContent = `~${burned}`;
        $("c-first").textContent = data.first_text_ms == null ? "–" : `${data.first_text_ms} ms`;
        $("c-cost").textContent = usd(data.cost_usd);
        sessionCost += data.cost_usd;
        $("c-session").textContent = usd(sessionCost);
        strip.finished();
        logLine(since(), `done: ${data.output_tokens} output tokens, ${data.stop_reason}`);
        if (data.stop_reason === "refusal") {
          answer.remove();
          bubble("error", "The engine declined that one. Try asking another way.");
          return null;
        }
        break;
      }
      case "error":
        strip.finished();
        answer.remove();
        bubble("error", data.reason);
        logLine(since(), `error: ${data.reason}`);
        return null;
    }
  }
  strip.finished();
  return reply || null;
}

// Loads Turnstile only if the relay has it switched on.
async function setupCheck() {
  const config = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  if (!config.turnstile_site_key) return;
  sendBtn.disabled = true;
  await new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.onload = resolve;
    document.head.append(script);
  });
  $("check").hidden = false;
  turnstileWidget = window.turnstile.render("#check", {
    sitekey: config.turnstile_site_key,
    callback: (token) => {
      turnstileToken = token;
      sendBtn.disabled = busy || userTurns() >= MAX_TURNS;
    },
    "expired-callback": () => (turnstileToken = null),
  });
}

function resetCheck() {
  pass = null;
  turnstileToken = null;
  if (turnstileWidget == null) return;
  $("check").hidden = false;
  window.turnstile.reset(turnstileWidget);
}

// Minimal SSE reader for a fetch() body (EventSource can't POST).
async function* sse(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let cut;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

function bubble(kind, text) {
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.textContent = text;
  convo.append(el);
  el.scrollIntoView({ block: "nearest" });
  return el;
}

function logLine(ms, text) {
  const li = document.createElement("li");
  const t = document.createElement("span");
  t.textContent = `${ms} ms`;
  li.append(t, text);
  log.append(li);
}

function userTurns() {
  return history.filter((m) => m.role === "user").length;
}

function updateTurns() {
  const left = MAX_TURNS - userTurns();
  $("turns").textContent = left <= 0 ? "That's the end of this conversation. Start over to keep going." : left < MAX_TURNS ? `${left} messages left in this conversation` : "";
}

function usd(n) {
  return `$${n.toFixed(5)}`;
}

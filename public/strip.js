// The wire-and-engine strip. Every call here is driven by a real event from the relay.
const NS = "http://www.w3.org/2000/svg";
const OUT_Y = 44;
const BACK_Y = 68;
// Wire ends, matching the lines in index.html.
const LEG1 = { from: 64, to: 216 };
const LEG2 = { from: 296, to: 464 };

const layer = document.getElementById("packets");
const port = document.getElementById("port");
const still = matchMedia("(prefers-reduced-motion: reduce)");
let lastInbound = 0;

// Packets leave the browser: one dot per ~10 tokens of the request, at most 16.
export function sendOut(estTokens) {
  reset();
  live("leg1", true);
  burst(Math.min(16, Math.max(3, Math.round(estTokens / 10))), LEG1.from, LEG1.to, OUT_Y, "out");
}

// The relay forwards the request to the API.
export function dispatch(estTokens, legMs) {
  label("leg1-ms", `${legMs} ms`);
  live("leg2", true);
  burst(Math.min(16, Math.max(3, Math.round(estTokens / 10))), LEG2.from, LEG2.to, OUT_Y, "out");
}

// The API has the request; inputTokens is now exact.
export function accepted(inputTokens, ms) {
  label("leg2-ms", `${ms} ms · ${inputTokens} tokens`);
}

export function thinking() {
  port.classList.add("thinking");
}

// One blue dot per text chunk, travelling port → relay → you. Throttled so long answers stay calm.
export function inbound() {
  port.classList.remove("thinking");
  port.classList.add("speaking");
  const now = performance.now();
  if (now - lastInbound < 70) return;
  lastInbound = now;
  travel(LEG2.to, LEG2.from, BACK_Y, "in", 0, 280).then(() => travel(LEG1.to, LEG1.from, BACK_Y, "in", 0, 220));
}

export function finished() {
  port.classList.remove("thinking", "speaking");
  setTimeout(() => {
    live("leg1", false);
    live("leg2", false);
  }, 600);
}

function reset() {
  layer.replaceChildren();
  label("leg1-ms", "");
  label("leg2-ms", "");
  port.classList.remove("thinking", "speaking");
}

function burst(n, from, to, y, kind) {
  for (let i = 0; i < n; i++) travel(from, to, y, kind, i * 35, 380);
}

function travel(from, to, y, kind, delay, duration) {
  if (still.matches) return Promise.resolve();
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("class", `packet ${kind}`);
  dot.setAttribute("cx", from);
  dot.setAttribute("cy", y);
  dot.setAttribute("r", 3);
  dot.style.opacity = 0;
  layer.append(dot);
  const anim = dot.animate(
    [
      { transform: "translateX(0)", opacity: 1 },
      { transform: `translateX(${to - from}px)`, opacity: 1 },
    ],
    { duration, delay, easing: "ease-in-out", fill: "forwards" },
  );
  return anim.finished.then(() => dot.remove(), () => dot.remove());
}

function live(id, on) {
  document.getElementById(id).classList.toggle("live", on);
}

function label(id, text) {
  document.getElementById(id).textContent = text;
}

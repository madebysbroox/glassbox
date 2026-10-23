// Star Wars-style crawl: once the conversation outgrows its box, older messages tilt back and fade
// as they rise toward the top. Scrolling a message down toward the bottom brings it flat again.
const FLAT_PX = 180; // messages this close to the bottom stay flat
const RAMP_PX = 240; // then tilt over this distance
const MAX_TILT = 40;
const MIN_SCALE = 0.8;
const MIN_OPACITY = 0.2;

const still = matchMedia("(prefers-reduced-motion: reduce)");
let box = null;
let queued = false;

export function attach(el) {
  box = el;
  box.addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update);
  still.addEventListener("change", update);
}

// Keep the newest message in view, unless the visitor has scrolled up to read.
export function follow(force = false) {
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.classList.toggle("crawling", box.scrollHeight > box.clientHeight + 1);
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
  update();
}

export function update() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const bottom = box.getBoundingClientRect().bottom;
    const crawling = box.classList.contains("crawling");
    for (const msg of box.children) {
      const r = msg.getBoundingClientRect();
      const t = crawling ? Math.min(1, Math.max(0, (bottom - r.bottom - FLAT_PX) / RAMP_PX)) : 0;
      msg.style.opacity = t ? (1 - t * (1 - MIN_OPACITY)).toFixed(3) : "";
      msg.style.transform = still.matches || !t
        ? ""
        : `perspective(500px) rotateX(${(t * MAX_TILT).toFixed(2)}deg) scale(${(1 - t * (1 - MIN_SCALE)).toFixed(3)})`;
    }
  });
}

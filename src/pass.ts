// A pass is what a visitor gets for solving Turnstile once: "<expiry ms>.<hex HMAC of expiry>",
// signed with the Turnstile secret, so they aren't challenged on every message.
const PASS_TTL_MS = 60 * 60 * 1000;

export async function issuePass(secret: string, now: number): Promise<string> {
  const expiry = String(now + PASS_TTL_MS);
  return `${expiry}.${await sign(secret, expiry)}`;
}

export async function checkPass(secret: string, pass: unknown, now: number): Promise<boolean> {
  if (typeof pass !== "string") return false;
  const [expiry, mac] = pass.split(".");
  if (!expiry || !mac || !(Number(expiry) > now)) return false;
  const expected = await sign(secret, expiry);
  return timingSafeEqual(mac, expected);
}

export async function verifyTurnstile(secret: string, token: unknown, ip: string): Promise<boolean> {
  if (typeof token !== "string" || !token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  if (!res.ok) return false;
  const outcome = (await res.json()) as { success?: boolean };
  return outcome.success === true;
}

async function sign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

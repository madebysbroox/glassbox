import { DurableObject } from "cloudflare:workers";

export type Admission = { ok: true } | { ok: false; reason: "rate" | "cap" };

// One global instance keeps the per-IP hourly counts and the day's spend.
// A Durable Object handles one call at a time, so the read-then-write below can't race.
export class Guard extends DurableObject {
  async admit(ip: string, now: number, hourlyLimit: number, dailyCapUsd: number): Promise<Admission> {
    const spent = (await this.ctx.storage.get<number>(spendKey(now))) ?? 0;
    if (spent >= dailyCapUsd) return { ok: false, reason: "cap" };

    const hour = Math.floor(now / 3_600_000);
    const key = `ip:${ip}`;
    const seen = await this.ctx.storage.get<{ hour: number; n: number }>(key);
    const n = seen?.hour === hour ? seen.n : 0;
    if (n >= hourlyLimit) return { ok: false, reason: "rate" };

    await this.ctx.storage.put(key, { hour, n: n + 1 });
    return { ok: true };
  }

  async record(costUsd: number, now: number): Promise<number> {
    const key = spendKey(now);
    const total = ((await this.ctx.storage.get<number>(key)) ?? 0) + costUsd;
    await this.ctx.storage.put(key, total);
    return total;
  }
}

// Days roll over at midnight UTC.
function spendKey(now: number): string {
  return `spend:${new Date(now).toISOString().slice(0, 10)}`;
}

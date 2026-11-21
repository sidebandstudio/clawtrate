// Gateway settings the routine-editing checks need for a moment and then put
// back: the scheduler on (a development gateway runs with it off, so a new
// routine can be seen waiting for its slot, F-354), and the gateway's inbound
// hooks on (off by default, so a routine's page can show their address,
// F-349). Both apply without a restart (observed on 2026.10.6).

import { randomBytes } from "node:crypto";
import type { GatewayCall } from "./routines.ts";

async function patch(call: GatewayCall, change: Record<string, unknown>): Promise<void> {
  const { hash } = (await call("config.get", {})) as { hash?: string };
  await call("config.patch", { raw: JSON.stringify(change), ...(hash ? { baseHash: hash } : {}) });
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let tries = 0; tries < 50; tries += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the gateway did not report ${what}`);
}

const schedulerOn = async (call: GatewayCall) =>
  ((await call("cron.status", {})) as { enabled?: boolean }).enabled === true;

/** Runs `check` with the gateway's scheduler on, and turns it off again whatever happens. */
export async function withScheduler<T>(call: GatewayCall, check: () => Promise<T>): Promise<T> {
  await patch(call, { cron: { enabled: true } });
  try {
    await until(() => schedulerOn(call), "the scheduler on");
    return await check();
  } finally {
    await patch(call, { cron: { enabled: false } });
    await until(async () => !(await schedulerOn(call)), "the scheduler off");
  }
}

/**
 * Turns the gateway's hooks on or off. On, they take a new random token that
 * is returned and kept nowhere else; the gateway redacts it in `config.get`.
 */
export async function setHooks(call: GatewayCall, enabled: boolean): Promise<string | null> {
  const token = enabled ? randomBytes(24).toString("base64url") : null;
  await patch(call, { hooks: token ? { enabled, token, path: "/hooks" } : { enabled } });
  await until(
    async () => {
      const { config } = (await call("config.get", {})) as {
        config?: { hooks?: { enabled?: boolean } };
      };
      return (config?.hooks?.enabled === true) === enabled;
    },
    `hooks ${enabled ? "on" : "off"}`,
  );
  return token;
}

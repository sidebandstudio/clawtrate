// Loaded with `--import` into a preview host of e2e/protected-gateway.ts only:
// the test's own name for this run's gateway resolves to loopback in that one
// process, so its connection and its reads go to the test's TLS proxy.
import dns from "node:dns";

export const PROTECTED_HOST = "gateway.clawtrate.test";

type Callback = (error: Error | null, address: unknown, family?: number) => void;

const lookup = dns.lookup;
dns.lookup = function (this: unknown, ...args: unknown[]) {
  const [hostname, options, callback] = args;
  if (hostname !== PROTECTED_HOST) return Reflect.apply(lookup, this, args) as unknown;
  const done = (typeof options === "function" ? options : callback) as Callback;
  const all = typeof options === "object" && options !== null && "all" in options && options.all;
  if (all) process.nextTick(done, null, [{ address: "127.0.0.1", family: 4 }]);
  else process.nextTick(done, null, "127.0.0.1", 4);
} as typeof dns.lookup;

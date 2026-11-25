// The accounts instance, for accounts.spec.ts, machines.spec.ts and check-ins.spec.ts: unseeded,
// with the scripted provider accounts and sign-ins (docs/design/bots.md), so nothing they create
// reaches the seeded instance's checks, and a paired machine (`--with-node`) for Settings,
// Machines and "Where a bot runs".
//
// It is a worker fixture: the first of those specs a worker runs starts it, the others reuse it,
// and it is reset when the worker ends. So only a runner whose list has one of them starts it. It
// is written to a run record of its own before it starts, so a killed worker's instance is reset
// and removed by the next `pnpm e2e` (e2e/run-record.ts).
import { expect, test as base } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { newRunId, processIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import { devGateway, FORBIDDEN_PORTS, listInstances, resetInstance } from "./global-setup.ts";
import { cleanUp, recordPath, saveRecord, type RunRecord } from "./run-record.ts";

const RECORDS = join(import.meta.dirname, "../tools/dev-gateway/.run/e2e");
const record: RunRecord = {
  run: randomBytes(4).toString("hex"),
  runner: { pid: process.pid, identity: "" },
  instances: [],
  host: null,
  dirs: [],
};

/** The instance's name, the same in every spec this worker runs. */
export const ACCOUNTS = `e2e-${record.run}-acct`;

export const test = base.extend<object, { accountsInstance: string }>({
  accountsInstance: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const self = processIdentity(process.pid);
      if (self.state !== "alive") throw new Error("could not determine this worker's start time");
      record.runner.identity = self.identity;
      const runId = newRunId();
      record.instances.push({ name: ACCOUNTS, runId });
      saveRecord(RECORDS, record);
      process.stdout.write(
        devGateway(
          ACCOUNTS,
          "start",
          "--run-id",
          runId,
          "--with-accounts",
          "--with-plugin",
          "clawtrate-dev-signin",
          "--with-node",
          "--no-seed",
        ),
      );
      const mine = listInstances().find((row) => row.name === ACCOUNTS);
      if (!mine?.gatewayRunning) throw new Error(`instance ${ACCOUNTS} is not running`);
      for (const port of [mine.gatewayPort, mine.providerPort]) {
        if (port === null || FORBIDDEN_PORTS.includes(port)) {
          throw new Error(`instance ${ACCOUNTS} is on port ${port}, which e2e never uses`);
        }
      }
      await use(ACCOUNTS);
      // The specs stopped their hosts in their own afterAll; the instance is reset, and its record
      // goes too.
      expect(cleanUp(RECORDS, record, resetInstance), "the accounts instance's run record").toEqual(
        [],
      );
      expect(existsSync(recordPath(RECORDS, record.run))).toBe(false);
      expect(
        listInstances().some((row) => row.name === ACCOUNTS),
        "the accounts instance",
      ).toBe(false);
    },
    { scope: "worker", timeout: 300_000 },
  ],
});

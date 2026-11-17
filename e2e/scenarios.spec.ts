// The scenario check, as part of `pnpm e2e`, on this run's own seeded
// instance. `pnpm scenarios` runs the same checks on an instance of its own.

import { expect, test } from "@playwright/test";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import {
  createHarness,
  openCheckClients,
  prepareRecipient,
  SCENARIO_CHECKS,
  UNDECLARED_FIELDS,
  type ClientName,
  type Harness,
} from "../tools/dev-gateway/src/scenario-check.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;

test.describe.serial("scenario check", () => {
  let clients: Record<ClientName, OperatorSession>;
  let harness: Harness & { notes: string[] };

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    expect(INSTANCE, "global setup names this run's instance").toMatch(/^e2e-[0-9a-f]{8}$/);
    const inst = openInstance(INSTANCE);
    clients = await openCheckClients((name, scopes, caps) =>
      openOperator(inst, name, scopes, caps),
    );
    harness = createHarness(clients);
    await prepareRecipient(harness);
  });

  test.afterAll(async () => {
    for (const note of harness?.notes ?? []) console.log(`note  ${note}`);
    for (const [kind, fields] of UNDECLARED_FIELDS) {
      console.log(`note  ${kind} carries undeclared fields: ${[...fields].sort().join(", ")}`);
    }
    for (const op of Object.values(clients ?? {})) await op.close();
  });

  for (const check of SCENARIO_CHECKS) {
    test(`${check.name} (${check.covers.join(" ")})`, async () => {
      test.setTimeout(180_000);
      await check.run(harness);
    });
  }
});

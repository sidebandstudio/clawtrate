// The Worker under test: the real Worker and object, with the test's limits, an optional fast
// clock and an optional failing store, all set through vars by `test/support.ts`.

import { DEFAULT_LIMITS, type RelayLimits, type SqlDriver } from "../../src/core/index.ts";
import { RelayRoomObject as Base, type Env, type WorkerClock } from "../../src/worker/index.ts";
import { faultySql, warpedClock, type Fault } from "./faults.ts";

export { default } from "../../src/worker/index.ts";

interface TestEnv extends Env {
  readonly TEST_LIMITS?: string;
  readonly TEST_WARP?: string;
  readonly TEST_EPOCH?: string;
  readonly TEST_FAULT?: string;
}

export class RelayRoomObject extends Base {
  get #env(): TestEnv {
    return this.env as TestEnv;
  }

  protected override roomLimits(): RelayLimits {
    return { ...DEFAULT_LIMITS, ...(JSON.parse(this.#env.TEST_LIMITS ?? "{}") as object) };
  }

  protected override roomClock(): WorkerClock {
    const factor = Number(this.#env.TEST_WARP ?? "1");
    if (factor === 1) return super.roomClock();
    return warpedClock(Number(this.#env.TEST_EPOCH), factor);
  }

  protected override roomSql(): SqlDriver {
    const fault = this.#env.TEST_FAULT as Fault | undefined;
    return fault === undefined ? super.roomSql() : faultySql(super.roomSql(), fault);
  }
}

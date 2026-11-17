// The development config contract: the whole config a development gateway
// may run with, and nothing else. `sandboxProblems` compares a config with it
// and reports every key the contract does not name, every value that differs
// and every required key that is missing, each with its path. There is no list
// of known bad settings to keep up to date: anything new is refused.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A value the contract accepts by a test instead of by equality. */
export class Matcher {
  readonly describe: string;
  readonly test: (value: unknown) => boolean;
  constructor(describe: string, test: (value: unknown) => boolean) {
    this.describe = describe;
    this.test = test;
  }
}

/** A key that may be absent; when present it must match its contract. */
export class Optional {
  readonly contract: Contract;
  constructor(contract: Contract) {
    this.contract = contract;
  }
}

export type Contract = Json | Matcher | Optional | { [key: string]: Contract } | Contract[];

export const matching = (describe: string, test: (value: unknown) => boolean) =>
  new Matcher(describe, test);
export const optional = (contract: Contract) => new Optional(contract);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const show = (value: unknown) => {
  const text = JSON.stringify(value);
  return text === undefined ? "nothing" : text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

/** Every way `value` differs from `contract`, as one line per difference with its path. */
export function contractProblems(value: unknown, contract: Contract, path = ""): string[] {
  const at = path || "the config";
  if (contract instanceof Optional) return contractProblems(value, contract.contract, path);
  if (contract instanceof Matcher) {
    return contract.test(value) ? [] : [`${at} must be ${contract.describe}, found ${show(value)}`];
  }
  if (Array.isArray(contract)) {
    return JSON.stringify(value) === JSON.stringify(contract)
      ? []
      : [`${at} must be exactly ${show(contract)}, found ${show(value)}`];
  }
  if (isPlainObject(contract)) {
    if (!isPlainObject(value)) return [`${at} must be an object, found ${show(value)}`];
    const problems: string[] = [];
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(contract, key))
        problems.push(`${path ? `${path}.` : ""}${key} is not allowed`);
    }
    for (const [key, sub] of Object.entries(contract)) {
      const child = path ? `${path}.${key}` : key;
      if (!Object.hasOwn(value, key)) {
        if (!(sub instanceof Optional)) problems.push(`${child} is required`);
        continue;
      }
      problems.push(...contractProblems(value[key], sub, child));
    }
    return problems;
  }
  return Object.is(value, contract)
    ? []
    : [`${at} must be ${show(contract)}, found ${show(value)}`];
}

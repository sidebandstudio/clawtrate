import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkIds,
  listPlaywright,
  listVitest,
  parityProblems,
  parseTable,
  playwrightChecks,
  skipProblems,
  testFiles,
  vitestChecks,
  type CheckPath,
} from "./parity.ts";

const ROOT = join(import.meta.dirname, "..");
const LISTING = 60_000;

describe("the parity table", () => {
  it(
    "has a check that runs for every row marked done, and every check names a real row",
    () => {
      const rows = parseTable(readFileSync(join(ROOT, "docs/parity.md"), "utf8"));
      expect(rows.length).toBeGreaterThan(400);
      const checks = [
        ...listVitest(ROOT),
        ...listPlaywright(ROOT, join(ROOT, "playwright.config.ts")),
        ...listPlaywright(ROOT, join(ROOT, "playwright.visual.config.ts")),
      ];
      expect(checks.length).toBeGreaterThan(400);
      expect(parityProblems(rows, new Set(checkIds(checks)))).toEqual([]);
      // No file that names a row skips any of its checks. The guard's own tests are exempt.
      const files = ["e2e", "visual", "test", "packages", "apps", "tools"]
        .flatMap((dir) => testFiles(join(ROOT, dir)))
        .map((path) => relative(ROOT, path))
        .filter((path) => !path.startsWith("test/parity"));
      expect(files.length).toBeGreaterThan(20);
      expect(
        files.flatMap((path) => skipProblems(path, readFileSync(join(ROOT, path), "utf8"))),
      ).toEqual([]);
    },
    LISTING,
  );

  it("reads ids, platforms and statuses from table rows", () => {
    const rows = parseTable(
      [
        "| id | area | platform | behavior | target | dependency | status |",
        "|---|---|---|---|---|---|---|",
        "| F-001 | Onboarding (§1) | both | a | b | c | desktop done |",
        "| F-012 | Sidebar (§2) | desktop | a | b | c | todo |",
      ].join("\n"),
    );
    expect(rows).toEqual([
      { id: "F-001", platform: "both", status: "desktop done" },
      { id: "F-012", platform: "desktop", status: "todo" },
    ]);
  });

  it("reads the ids at the start of a check's title or a group's title only", () => {
    const checks: CheckPath[] = [
      ["F-013 F-015: pinned tiles"],
      ["F-002, F-003: pairing"],
      ["F-020: working", "the ring turns"],
      ["the rail", "F-471: main view"],
      ["shows F-099 in the middle"],
    ];
    expect(checkIds(checks)).toEqual(["F-013", "F-015", "F-002", "F-003", "F-020", "F-471"]);
  });

  it("reads Vitest's and Playwright's listings, and leaves out what Playwright will skip", () => {
    expect(vitestChecks(JSON.stringify([{ name: "group > F-001: a", file: "x" }]))).toEqual([
      ["group", "F-001: a"],
    ]);
    const suite = {
      suites: [
        {
          title: "a.spec.ts",
          specs: [
            { title: "F-001: runs", tests: [{ expectedStatus: "passed" }] },
            { title: "F-002: skipped", tests: [{ expectedStatus: "skipped" }] },
          ],
          suites: [
            {
              title: "F-003: group",
              specs: [{ title: "x", tests: [{ expectedStatus: "passed" }] }],
            },
          ],
        },
      ],
    };
    expect(playwrightChecks(JSON.stringify(suite))).toEqual([
      ["F-001: runs"],
      ["F-003: group", "x"],
    ]);
  });

  it("fails a check that skips itself inside its body, unconditionally or on a condition, and names the file and line", () => {
    const source = [
      'import { test } from "@playwright/test";',
      'test("F-004: no proof", () => {',
      "  test.skip(true);",
      "});",
      'test("F-005: not here", ({ browserName }) => {',
      '  test.skip(browserName === "webkit", "not on WebKit");',
      "});",
    ].join("\n");
    expect(skipProblems("e2e/a.spec.ts", source)).toEqual([
      "e2e/a.spec.ts:3: test.skip in a file whose checks name parity rows",
      "e2e/a.spec.ts:6: test.skip in a file whose checks name parity rows",
    ]);
  });

  it("fails skip, fixme, todo and only as modifiers, and leaves files that name no row alone", () => {
    const lines = [
      'test.describe.only("F-001: group", () => {});',
      'it.todo("F-002: later");',
      'describe.skip("F-003: group", () => {});',
      'test.fixme("F-004: broken", () => {});',
      "test.describe.configure({ mode: 'serial' });",
    ];
    expect(skipProblems("visual/b.spec.ts", lines.join("\n"))).toEqual([
      "visual/b.spec.ts:1: test.describe.only in a file whose checks name parity rows",
      "visual/b.spec.ts:2: it.todo in a file whose checks name parity rows",
      "visual/b.spec.ts:3: describe.skip in a file whose checks name parity rows",
      "visual/b.spec.ts:4: test.fixme in a file whose checks name parity rows",
    ]);
    expect(skipProblems("x.test.ts", 'test("no row here", () => { test.skip(true); });')).toEqual(
      [],
    );
  });

  it("fails a done row without a check, a check for no row, and an unknown status", () => {
    const rows = [
      { id: "F-001", platform: "both", status: "desktop done" },
      { id: "F-002", platform: "desktop", status: "done" },
      { id: "F-003", platform: "desktop", status: "desktop done" },
      { id: "F-004", platform: "both", status: "finished" },
      { id: "F-005", platform: "both", status: "todo" },
    ];
    expect(parityProblems(rows, new Set(["F-001", "F-003", "F-999"]))).toEqual([
      "F-002: marked done, but no check that runs names it",
      'F-003: "desktop done" is only for rows whose platform is both',
      'F-004: unknown status "finished"',
      "F-999: a check names it, but the table has no such row",
    ]);
  });
});

// Each case below writes a Vitest file and a Playwright spec whose only mention
// of a row is a check that never runs, lists them with the real runners, and
// expects the row marked done to fail. The folder is inside the checkout so the
// specs can import the runners; test-results/ is ignored by git.
describe("the gateway dependency of the saved approvals and activity rows", () => {
  /** A row's gateway dependency cell, apart from its target and status. */
  const dependency = (id: string) => {
    const line = readFileSync(join(ROOT, "docs/parity.md"), "utf8")
      .split("\n")
      .find((each) => each.startsWith(`| ${id} |`));
    return line?.split("|")[6]?.trim() ?? "";
  };

  it("F-324 names the native request, its history join, history's missing ids, the review event and the missing ledger", () => {
    const cell = dependency("F-324");
    expect(cell).toContain("For observed native exec requests, the event's run and call identify");
    expect(cell).toContain("its approval id joins to the answer in approval history");
    expect(cell).toContain("Approval history alone carries no run or call id.");
    expect(cell).toContain(
      "The Guardian review event can name a command's run, call, outcome and rationale",
    );
    expect(cell).toContain(
      "A complete retained ledger needs each reviewed action's verdict and source",
    );
  });

  it("F-326 names the plugin's Ask and no standing grant, the days-only routine grant, the capped placement end and the missing hour grant", () => {
    const cell = dependency("F-326");
    expect(cell).toContain("The rules plugin can ask and record Allow once or Deny.");
    expect(cell).toContain("It issues no standing grant from that answer.");
    expect(cell).toContain("takes whole days, 1 to 3650");
    expect(cell).toContain("a recorded end at most 30 days after minting");
    expect(cell).toContain("The target needs an authorized, action-scoped one-hour grant");
  });
});

describe("the parity table does not count a check that never runs", () => {
  let dir: string;
  const ROWS = [
    { id: "F-001", platform: "desktop", status: "done" },
    { id: "F-004", platform: "desktop", status: "done" },
  ];

  beforeAll(() => {
    mkdirSync(join(ROOT, "test-results"), { recursive: true });
    dir = mkdtempSync(join(ROOT, "test-results", "parity-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function problemsFor(name: string, vitestBody: string, playwrightBody: string): string[] {
    const folder = join(dir, name);
    mkdirSync(folder);
    writeFileSync(
      join(folder, "vitest.config.mjs"),
      'export default { test: { include: ["*.test.ts"] } };\n',
    );
    writeFileSync(
      join(folder, "a.test.ts"),
      `import { describe, it, test } from "vitest";\ntest("F-001: runs", () => {});\n${vitestBody}\n`,
    );
    writeFileSync(
      join(folder, "playwright.config.mjs"),
      "export default { testDir: '.', testMatch: '*.spec.ts' };\n",
    );
    writeFileSync(
      join(folder, "a.spec.ts"),
      `import { test } from "@playwright/test";\ntest("F-001: runs", () => {});\n${playwrightBody}\n`,
    );
    const vitest = listVitest(ROOT, folder);
    const playwright = listPlaywright(ROOT, join(folder, "playwright.config.mjs"));
    // The check that runs is seen by both runners, so the listing works.
    expect(checkIds(vitest)).toEqual(["F-001"]);
    expect(checkIds(playwright)).toEqual(["F-001"]);
    return parityProblems(ROWS, new Set(checkIds([...vitest, ...playwright])));
  }

  const FAILS = ["F-004: marked done, but no check that runs names it"];

  it(
    "a skipped, fixme or todo check",
    () => {
      expect(
        problemsFor(
          "skipped",
          [
            'test.skip("F-004: no proof", () => {});',
            'it.todo("F-004: later");',
            'describe.skip("F-004: group", () => { test("x", () => {}); });',
          ].join("\n"),
          [
            'test.skip("F-004: no proof", () => {});',
            'test.fixme("F-004: broken", () => {});',
            'test.describe.skip("F-004: group", () => { test("x", () => {}); });',
          ].join("\n"),
        ),
      ).toEqual(FAILS);
    },
    LISTING,
  );

  it(
    "a check that is never reached",
    () => {
      const body = [
        "// eslint-disable-next-line no-constant-condition",
        'if (false) test("F-004: no proof", () => {});',
        'function never() { test("F-004: no proof", () => {}); }',
        "void never;",
      ].join("\n");
      expect(problemsFor("unreachable", body, body)).toEqual(FAILS);
    },
    LISTING,
  );

  it(
    "a check that is commented out",
    () => {
      const body = [
        '// test("F-004: no proof", () => {});',
        '/* test("F-004: no proof", () => {}); */',
      ].join("\n");
      expect(problemsFor("commented", body, body)).toEqual(FAILS);
    },
    LISTING,
  );
});

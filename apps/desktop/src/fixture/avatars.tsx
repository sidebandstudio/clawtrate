// `?sheet=avatars`: every creature family in every state at every size the app
// draws avatars at, with the state ring and badge, for the visual tests
// (visual/avatars.visual.spec.ts). Invented bots; nothing from a gateway.

import { pictureWithChoice, type AvatarChoice, type Bot } from "@clawtrate/core";
import { Presence } from "@clawtrate/ui";
import type { CSSProperties } from "react";
import { SHEET_SIZES } from "./avatar-sizes.ts";

/** A 2×2 PNG for the choice to ride in, as a gateway keeps it. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC";

const ROWS: Array<{ name: string; choice: AvatarChoice | null }> = [
  { name: "Atlas", choice: null },
  {
    name: "Juniper",
    choice: { family: "clawling", body: "tall", eyes: "splayed", claws: "fiddler", color: "green" },
  },
  { name: "Wren", choice: { family: "shellfolk", shell: "spiral", color: "blue" } },
  {
    name: "Otto",
    choice: { family: "lantern", body: "round", lure: "hook", eyes: "two", color: "sky" },
  },
];

const STATES = ["idle", "thinking", "working", "waiting", "blocked", "done"] as const;

function botFor(row: (typeof ROWS)[number]): Bot {
  return {
    id: row.name.toLowerCase(),
    name: row.name,
    emoji: null,
    avatarUrl: row.choice ? pictureWithChoice(PNG, row.choice) : null,
    theme: null,
    model: null,
    isDefault: false,
  };
}

export function AvatarSheet() {
  return (
    <main
      className="app"
      style={{ padding: 24, minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}
    >
      <style>{".sheet-presence .presence { --size: var(--sheet); }"}</style>
      <table style={{ borderSpacing: "14px 10px" }}>
        <thead>
          <tr>
            <th />
            {STATES.map((state) => (
              <th key={state} style={{ fontWeight: 500, fontSize: 12, color: "var(--text-faint)" }}>
                {state}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SHEET_SIZES.flatMap((size) =>
            ROWS.map((row) => (
              <tr key={`${size}-${row.name}`}>
                <th
                  style={{
                    fontWeight: 400,
                    fontSize: 12,
                    color: "var(--text-faint)",
                    textAlign: "right",
                  }}
                >
                  {row.name} {size}
                </th>
                {STATES.map((state) => (
                  <td
                    key={state}
                    data-testid="sheet-cell"
                    data-size={size}
                    data-state={state}
                    style={{ textAlign: "center" }}
                  >
                    <span
                      style={{ "--sheet": `${size}px` } as CSSProperties}
                      className="sheet-presence"
                    >
                      <Presence
                        bot={botFor(row)}
                        state={state}
                        badge={
                          state === "blocked" ? "blocked" : state === "waiting" ? "waiting" : null
                        }
                        hidden
                      />
                    </span>
                  </td>
                ))}
              </tr>
            )),
          )}
        </tbody>
      </table>
    </main>
  );
}

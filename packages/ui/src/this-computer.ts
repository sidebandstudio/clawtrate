// "Use This computer", the way on after a reconnect This computer's check refused, from the
// connection screen's form and from Settings, Gateway: a staged look. Nothing is forgotten. The
// saved gateway stays selected until the person presses Connect on the new offer and it
// connects (the client replaces it only then), or forgets it themselves; Back from the look
// returns to it, with Try again and Use This computer still there.
import type { BridgeCommand, SetupState } from "@clawtrate/core";
import { createContext } from "react";

/** Turns the staged look on or off. */
export type StageThisComputer = (on: boolean) => void;

/** The app's staged look: while it is on, the connection screen shows it, bots or not. */
export const ThisComputerStage = createContext<StageThisComputer | null>(null);

type Send = (command: BridgeCommand) => Promise<unknown>;

/** What both buttons do: stage the look, and start it. A look the host refused unstages it. */
export function thisComputer(send: Send, stage: StageThisComputer): Promise<void> {
  stage(true);
  return send({ type: "setupLook" }).then(
    () => {},
    () => stage(false),
  );
}

/** Back from the look on this computer: a look under way is stopped, what it found is let go. */
export function leaveLook(setup: SetupState): BridgeCommand {
  return { type: setup.phase === "looking" ? "setupCancel" : "setupReset" };
}

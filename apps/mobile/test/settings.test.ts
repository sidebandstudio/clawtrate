// Settings' device switches, rendered (F-519, F-562). React Native's components are host
// elements that keep their props, as in React Native's own tests: Switch takes the "switch"
// role and Modal renders nothing while hidden, as React Native's do. The tests find a switch as
// VoiceOver does, by its role and name.

import { initialState, type BridgeCommand } from "@clawtrate/core";
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import {
  DEVICE_SWITCHES,
  SETTINGS_WORDS,
  type DeviceSwitch,
} from "../src/presentation/gateway-state.ts";
import { RuntimeContext, type Runtime } from "../src/runtime.ts";
import { Settings } from "../src/screens/Settings.tsx";
import { createSwitchSaves } from "../src/switch-saves.ts";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    View: "View",
    Text: "Text",
    ScrollView: "ScrollView",
    Pressable: "Pressable",
    Switch: ({
      accessibilityRole,
      onValueChange,
      ...props
    }: {
      accessibilityRole?: string;
      onValueChange?: (on: boolean) => void;
    }) =>
      createElement("RCTSwitch", {
        ...props,
        accessibilityRole: accessibilityRole ?? "switch",
        onChange: (event: { nativeEvent: { value: boolean } }) =>
          onValueChange?.(event.nativeEvent.value),
      }),
    Modal: ({ visible, children }: { visible?: boolean; children?: ReactNode }) =>
      visible === false ? null : createElement("Modal", null, children),
  };
});
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("react-native-svg", () => ({ default: "Svg", Circle: "Circle", Path: "Path" }));
// The address screens' parts Settings shows for a plain address and Use another gateway.
vi.mock("../src/screens/Connect.tsx", () => ({
  Cleartext: () => null,
  UseAnotherGateway: () => null,
}));
vi.mock("../src/host/index.ts", () => ({
  DEVICE_NAME: "Clawtrate iPhone",
  createIosHost: () => {
    throw new Error("the unit tests start no iOS host");
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FLOW: Record<DeviceSwitch["id"], string> = {
  "channel-chats": "F-519",
  "gateway-bot": "F-562",
};

type Shown = { showChannelChats: boolean; showGatewayBot: boolean };
const OFF: Shown = { showChannelChats: false, showGatewayBot: false };

/** Settings over the app's runtime, its switches as core reports them. */
function settings(send: (command: BridgeCommand) => Promise<unknown>) {
  const redact = (text: string) => text;
  const runtime = { send, redact, saves: createSwitchSaves(send, redact) } as unknown as Runtime;
  const sheet = (visible: boolean, shown: Shown) =>
    createElement(
      RuntimeContext.Provider,
      { value: runtime },
      createElement(Settings, {
        state: { connection: initialState.connection, ...shown },
        visible,
        onClose: () => {},
        onForget: () => {},
      }),
    );
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(sheet(true, OFF));
  });
  return {
    renderer,
    show: (visible: boolean, shown: Shown = OFF) =>
      act(() => renderer.update(sheet(visible, shown))),
  };
}

function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

/** Out of VoiceOver's reach: inside an element hidden from accessibility. */
function hidden(node: ReactTestInstance): boolean {
  for (let at: ReactTestInstance | null = node; at; at = at.parent)
    if (
      at.props.accessibilityElementsHidden === true ||
      at.props.importantForAccessibility === "no-hide-descendants"
    )
      return true;
  return false;
}

/** The elements VoiceOver reads with this role and name: its label, or else its text. */
function byRole(renderer: ReactTestRenderer, role: string, name: string): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) =>
      typeof node.type === "string" &&
      node.props.accessibilityRole === role &&
      ((node.props.accessibilityLabel as string | undefined) ?? textOf(node)) === name &&
      !hidden(node),
  );
}

function theSwitch(renderer: ReactTestRenderer, name: string): ReactTestInstance {
  const found = byRole(renderer, "switch", name);
  expect(found, `one switch named "${name}"`).toHaveLength(1);
  return found[0]!;
}

async function flip(renderer: ReactTestRenderer, name: string, on: boolean) {
  const control = theSwitch(renderer, name);
  await act(async () => control.props.onChange({ nativeEvent: { value: on } }));
}

/** The row around a switch, which takes a tap anywhere on it. */
function rowOf(control: ReactTestInstance): ReactTestInstance {
  let at = control.parent;
  while (at && (at.type as string) !== "Pressable") at = at.parent;
  return at!;
}

function press(renderer: ReactTestRenderer, testID: string) {
  const button = renderer.root.find(
    (node) => (node.type as string) === "Pressable" && node.props.testID === testID,
  );
  act(() => button.props.onPress());
}

describe("Settings' device switches on iPhone", () => {
  it("F-562: Settings → Advanced has the switch, found by its role and name, off by default; turning it on asks core to show the gateway's own bot", async () => {
    const send = vi.fn((_command: BridgeCommand) => Promise.resolve());
    const { renderer, show } = settings(send);
    expect(byRole(renderer, "header", SETTINGS_WORDS.advanced)).toHaveLength(1);
    expect(theSwitch(renderer, SETTINGS_WORDS.gatewayBot).props).toMatchObject({
      value: false,
      disabled: false,
    });

    await flip(renderer, SETTINGS_WORDS.gatewayBot, true);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "setShowGatewayBot", on: true });
    expect(theSwitch(renderer, SETTINGS_WORDS.gatewayBot).props.value).toBe(true);
    // Core reports the choice kept: the switch shows it, and takes the next tap.
    show(true, { ...OFF, showGatewayBot: true });
    expect(theSwitch(renderer, SETTINGS_WORDS.gatewayBot).props).toMatchObject({
      value: true,
      disabled: false,
    });
    expect(byRole(renderer, "switch", SETTINGS_WORDS.channelChats)[0]!.props.value).toBe(false);
  });

  type View = ReturnType<typeof settings>;
  const away = [
    {
      way: "closing Settings and opening it again",
      leave: ({ show }: View) => show(false),
      back: ({ show }: View) => show(true),
    },
    {
      way: "opening Font licenses and going Back",
      leave: ({ renderer }: View) => press(renderer, "licenses-open"),
      back: ({ renderer }: View) => press(renderer, "licenses-back"),
    },
  ];
  for (const setting of DEVICE_SWITCHES)
    for (const { way, leave, back } of away)
      it(`${FLOW[setting.id]}: a save of "${setting.label}" still on its way after ${way} is shown, takes no second save, then shows its failure and goes back`, async () => {
        const save = Promise.withResolvers<void>();
        const send = vi.fn((_command: BridgeCommand) => save.promise);
        const view = settings(send);
        const { renderer } = view;
        await flip(renderer, setting.label, true);
        expect(send).toHaveBeenCalledExactlyOnceWith({ type: setting.command, on: true });

        leave(view);
        expect(byRole(renderer, "switch", setting.label)).toHaveLength(0);
        back(view);
        const reopened = theSwitch(renderer, setting.label);
        expect(reopened.props).toMatchObject({ value: true, disabled: true });
        expect(rowOf(reopened).props.disabled).toBe(true);
        // A tap on the switch or its row sends nothing while the first save is on its way.
        act(() => reopened.props.onChange({ nativeEvent: { value: false } }));
        act(() => rowOf(reopened).props.onPress());
        expect(send).toHaveBeenCalledTimes(1);

        await act(async () => save.reject(new Error("The Keychain could not keep the setting.")));
        expect(theSwitch(renderer, setting.label).props).toMatchObject({
          value: false,
          disabled: false,
        });
        expect(byRole(renderer, "alert", "The Keychain could not keep the setting.")).toHaveLength(
          1,
        );
      });
});

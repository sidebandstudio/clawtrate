// Settings, a sheet over the shell, with the desktop's Gateway pane in its words
// (`presentation/gateway-state.ts`): the address, the state and its dot, this
// device, the scopes the connection can use, the gateway's version, the error when
// there is one; Disconnect, which keeps the pairing, Reconnect, and Use another
// gateway, which forgets this one. Conversation and Advanced hold device settings.

import type { ClawtrateState } from "@clawtrate/core";
import { isCleartext, scopeWords } from "../presentation/connect-words.ts";
import {
  addressWords,
  DEVICE_SWITCHES,
  GATEWAY_APPEARANCE,
  gatewayActions,
  gatewayProblem,
  gatewayState,
  grantedWords,
  pairingNote,
  serverWords,
  SETTINGS_WORDS as W,
  type DeviceSwitch,
} from "../presentation/gateway-state.ts";
import { useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BackIcon, CloseIcon } from "../components/icons.tsx";
import { FONT_LICENSES } from "../font-licenses.ts";
import { Cleartext, UseAnotherGateway } from "./Connect.tsx";
import { Button, Dot, RoundButton, Txt } from "../components/ui.tsx";
import { DEVICE_NAME } from "../host/index.ts";
import { useRuntime } from "../runtime.ts";
import { FONTS, S, TOUCH, useTheme } from "../theme/index.ts";

/** Where the embedded fonts' licenses are read. */
const LICENSES_TITLE = "Font licenses";

function Fact({
  label,
  children,
  testID,
}: {
  label: string;
  children: ReactNode;
  testID?: string;
}) {
  const { c } = useTheme();
  return (
    <View
      style={{
        minHeight: 42,
        paddingVertical: 10,
        paddingHorizontal: S["space-4"],
        borderBottomWidth: 1,
        borderBottomColor: c.border,
        gap: 2,
      }}
    >
      <Txt size={S["text-sm"]} color="text-faint">
        {label}
      </Txt>
      <View
        testID={testID}
        style={{ flexDirection: "row", alignItems: "center", gap: S["space-2"] }}
      >
        {children}
      </View>
    </View>
  );
}

function DeviceSwitchRow({ setting, shown }: { setting: DeviceSwitch; shown: boolean }) {
  const { send, redact } = useRuntime();
  const { c } = useTheme();
  // The system's switch flips as it is tapped: it keeps the choice asked for until core
  // reports it, and goes back when the choice could not be kept.
  const [asked, setAsked] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One save at a time: a second tap before the first is kept could show the first's answer.
  const [saving, setSaving] = useState(false);
  if (asked !== null && asked === shown) setAsked(null);
  const value = asked ?? shown;
  const toggle = (on: boolean) => {
    setAsked(on);
    setSaving(true);
    setError(null);
    void send({ type: setting.command, on })
      .catch((failure: unknown) => {
        setAsked(null);
        setError(redact(failure instanceof Error ? failure.message : String(failure)));
      })
      .finally(() => setSaving(false));
  };
  return (
    <>
      <Txt
        testID={setting.headingId}
        size={S["text-sm"]}
        color="text-faint"
        accessibilityRole="header"
      >
        {setting.heading}
      </Txt>
      <Pressable
        accessible={false}
        disabled={saving}
        onPress={() => toggle(!value)}
        style={{
          minHeight: TOUCH.taskRow,
          flexDirection: "row",
          alignItems: "center",
          gap: S["space-3"],
          paddingVertical: 10,
          paddingHorizontal: S["space-4"],
          backgroundColor: c["bg-bubble"],
          borderRadius: S["radius-lg"],
        }}
      >
        {/* The whole row is tappable. VoiceOver uses the native switch. */}
        <Txt
          style={{ flex: 1 }}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {setting.label}
        </Txt>
        <Switch
          testID={setting.id}
          accessibilityLabel={setting.label}
          accessibilityHint={
            typeof setting.note === "string" ? setting.note : setting.note.join("")
          }
          value={value}
          disabled={saving}
          onValueChange={toggle}
          trackColor={{ false: c["border-strong"], true: c["bg-inverse"] }}
          ios_backgroundColor={c["border-strong"]}
          thumbColor={value ? c["text-inverse"] : undefined}
        />
      </Pressable>
      <Txt testID={`${setting.id}-note`} size={S["text-sm"]} color="text-faint">
        {typeof setting.note === "string" ? (
          setting.note
        ) : (
          <>
            {setting.note[0]}
            <Txt size={S["text-sm"]} color="text-faint" style={{ fontFamily: FONTS.mono }}>
              {setting.note[1]}
            </Txt>
            {setting.note[2]}
          </>
        )}
      </Txt>
      {error && (
        <View
          testID={`${setting.id}-error`}
          accessibilityRole="alert"
          style={{
            backgroundColor: c["danger-soft"],
            borderRadius: S["radius-md"],
            padding: S["space-4"],
          }}
        >
          <Txt size={S["text-md"]}>{error}</Txt>
        </View>
      )}
    </>
  );
}

export function Settings({
  state,
  visible,
  onClose,
  onForget,
}: {
  state: Pick<ClawtrateState, "connection" | DeviceSwitch["stateKey"]>;
  visible: boolean;
  onClose: () => void;
  /** After Use another gateway: the address screen. */
  onForget: () => void;
}) {
  const { connection } = state;
  const { send, redact } = useRuntime();
  const { c } = useTheme();
  const [licenses, setLicenses] = useState(false);
  const { label: status, dot } = GATEWAY_APPEARANCE[gatewayState(connection)];
  const problem = gatewayProblem(connection);
  const actions = gatewayActions(connection);
  const server = serverWords(connection);
  const pairing = pairingNote(connection);
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView edges={["bottom", "left", "right"]} style={{ flex: 1, backgroundColor: c.bg }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            padding: S["space-4"],
            gap: S["space-3"],
          }}
        >
          {licenses && (
            <RoundButton label={W.title} onPress={() => setLicenses(false)} testID="licenses-back">
              <BackIcon color={c.text} />
            </RoundButton>
          )}
          <Txt size={22} weight="strong" accessibilityRole="header" style={{ flex: 1 }}>
            {licenses ? LICENSES_TITLE : W.title}
          </Txt>
          <RoundButton label={W.close} onPress={onClose} testID="settings-close">
            <CloseIcon color={c.text} />
          </RoundButton>
        </View>
        {/* Each page has its own key, so each opens at its start: one scroll view
            for both would open the licenses as far down as Settings was. */}
        {licenses ? (
          <ScrollView
            key="licenses"
            testID="licenses"
            contentContainerStyle={{ padding: S["space-4"], gap: S["space-4"] }}
          >
            {FONT_LICENSES.map((license) => (
              <View key={license.name} style={{ gap: S["space-2"] }}>
                <Txt weight="medium" accessibilityRole="header">
                  {license.name}
                </Txt>
                <Txt size={S["text-sm"]} selectable style={{ fontFamily: FONTS.mono }}>
                  {license.text}
                </Txt>
              </View>
            ))}
          </ScrollView>
        ) : (
          <ScrollView
            key="settings"
            testID="settings"
            contentContainerStyle={{ padding: S["space-4"], gap: S["space-4"] }}
          >
            <Txt size={S["text-sm"]} color="text-faint">
              {W.gateway}
            </Txt>
            <View
              style={{
                backgroundColor: c["bg-bubble"],
                borderRadius: S["radius-lg"],
                overflow: "hidden",
              }}
            >
              <Fact label={W.address}>
                <Txt testID="gateway-address" selectable style={{ flexShrink: 1 }}>
                  {redact(addressWords(connection.gatewayUrl))}
                </Txt>
              </Fact>
              {isCleartext(connection.gatewayUrl) && (
                <View style={{ padding: S["space-3"] }}>
                  <Cleartext />
                </View>
              )}
              <Fact label={W.state} testID="gateway-state">
                <Dot tone={dot === "disconnected" ? "off" : dot} />
                <Txt testID="gateway-state-text">{status}</Txt>
              </Fact>
              <Fact label={W.device}>
                <Txt testID="gateway-device">
                  {DEVICE_NAME}
                  {connection.deviceId ? ` · ${connection.deviceId.slice(0, 8)}` : ""}
                </Txt>
              </Fact>
              <Fact label={W.scopes}>
                <Txt testID="granted-scopes">{redact(grantedWords(connection))}</Txt>
              </Fact>
              {connection.status === "connected" &&
                connection.scopes.map((scope) => (
                  <Txt
                    key={scope}
                    size={S["text-sm"]}
                    color="text-muted"
                    style={{ paddingHorizontal: S["space-4"], paddingTop: 6 }}
                  >
                    {redact(scopeWords(scope))}
                  </Txt>
                ))}
              {server && (
                <Fact label={W.server}>
                  <Txt testID="gateway-version">{redact(server)}</Txt>
                </Fact>
              )}
            </View>
            {problem && (
              <View
                testID="gateway-problem"
                accessibilityRole="alert"
                style={{
                  backgroundColor: c["danger-soft"],
                  borderRadius: S["radius-md"],
                  padding: S["space-4"],
                  gap: S["space-1"],
                }}
              >
                <Txt weight="medium">{problem.title}</Txt>
                <Txt size={S["text-md"]}>{redact(problem.message)}</Txt>
              </View>
            )}
            <View style={{ gap: S["space-2"] }}>
              {actions.reconnect && (
                <Button
                  label={W.reconnect}
                  variant="primary"
                  large
                  onPress={() => void send({ type: "retry" })}
                  testID="reconnect"
                />
              )}
              {actions.disconnect && (
                <Button
                  label={W.disconnect}
                  large
                  onPress={() => void send({ type: "suspend" })}
                  testID="disconnect"
                />
              )}
              {actions.forget && connection.gatewayUrl !== null && (
                <UseAnotherGateway
                  gatewayUrl={connection.gatewayUrl}
                  label={W.useAnother}
                  testID="forget"
                  onForgotten={onForget}
                />
              )}
              {actions.forget && (
                <Txt testID="forget-keeps" size={S["text-sm"]} color="text-faint">
                  {
                    "This device keeps its identity and any saved device token. Pairings are managed on the gateway."
                  }
                </Txt>
              )}
            </View>
            {pairing && (
              <Txt size={S["text-sm"]} color="text-faint">
                {redact(pairing)}
              </Txt>
            )}
            {DEVICE_SWITCHES.map((setting) => (
              <DeviceSwitchRow
                key={setting.id}
                setting={setting}
                shown={state[setting.stateKey] === true}
              />
            ))}
            <Button
              label={LICENSES_TITLE}
              variant="quiet"
              onPress={() => setLicenses(true)}
              testID="licenses-open"
            />
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

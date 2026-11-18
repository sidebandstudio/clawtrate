// Settings, a sheet over the shell, with the desktop's Gateway pane in its words
// (`@clawtrate/ui/gateway-state`): the address, the state and its dot, this
// device, the scopes the gateway granted, the gateway's version, the error when
// there is one; Disconnect, which keeps the pairing, Reconnect, and Use another
// gateway, which forgets this one.

import type { ConnectionState } from "@clawtrate/core";
import { scopeWords } from "@clawtrate/ui/connect-words";
import { gatewayLabel } from "@clawtrate/ui/format";
import {
  gatewayActions,
  gatewayDot,
  gatewayProblem,
  gatewayState,
  grantedWords,
  pairingNote,
  serverWords,
  SETTINGS_WORDS as W,
} from "@clawtrate/ui/gateway-state";
import type { ReactNode } from "react";
import { Modal, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CloseIcon } from "../components/icons.tsx";
import { Button, Dot, RoundButton, Txt } from "../components/ui.tsx";
import { DEVICE_NAME } from "../host/index.ts";
import { useRuntime } from "../runtime.ts";
import { S, useTheme } from "../theme/index.ts";

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

export function Settings({
  connection,
  visible,
  onClose,
  onForget,
}: {
  connection: ConnectionState;
  visible: boolean;
  onClose: () => void;
  /** After Use another gateway: the address screen. */
  onForget: () => void;
}) {
  const { send } = useRuntime();
  const { c } = useTheme();
  const state = gatewayState(connection);
  const dot = gatewayDot(state);
  const problem = gatewayProblem(connection);
  const actions = gatewayActions(connection);
  const server = serverWords(connection);
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView edges={["bottom"]} style={{ flex: 1, backgroundColor: c.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: S["space-4"] }}>
          <Txt size={22} weight="strong" accessibilityRole="header" style={{ flex: 1 }}>
            {W.title}
          </Txt>
          <RoundButton label={W.close} onPress={onClose} testID="settings-close">
            <CloseIcon color={c.text} />
          </RoundButton>
        </View>
        <ScrollView
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
              <Txt testID="gateway-address" selectable>
                {connection.gatewayUrl ?? W.noAddress}
              </Txt>
            </Fact>
            <Fact label={W.state} testID="gateway-state">
              <Dot tone={dot === "disconnected" ? "off" : dot} />
              <Txt testID="gateway-state-text">{state}</Txt>
            </Fact>
            <Fact label={W.device}>
              <Txt testID="gateway-device">
                {DEVICE_NAME}
                {connection.deviceId ? ` · ${connection.deviceId.slice(0, 8)}` : ""}
              </Txt>
            </Fact>
            <Fact label={W.scopes}>
              <Txt testID="granted-scopes">{grantedWords(connection)}</Txt>
            </Fact>
            {connection.status === "connected" &&
              connection.scopes.map((scope) => (
                <Txt
                  key={scope}
                  size={S["text-sm"]}
                  color="text-muted"
                  style={{ paddingHorizontal: S["space-4"], paddingTop: 6 }}
                >
                  {scopeWords(scope)}
                </Txt>
              ))}
            {server && (
              <Fact label={W.server}>
                <Txt>{server}</Txt>
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
              <Txt size={S["text-md"]}>{problem.message}</Txt>
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
            {actions.forget && (
              <Button
                label={W.useAnother}
                variant="quiet"
                large
                testID="forget"
                onPress={() => {
                  onClose();
                  onForget();
                  void send({ type: "disconnect" });
                }}
              />
            )}
          </View>
          {connection.gatewayUrl && (
            <Txt size={S["text-sm"]} color="text-faint">
              {pairingNote(gatewayLabel(connection.gatewayUrl), {
                holdsAll: false,
                readOnly: true,
              })}
            </Txt>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

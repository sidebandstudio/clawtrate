// Settings › OpenClaw (docs/design/gateway-settings.md section 3): one row in Settings' list for
// all of OpenClaw's own settings. Its parts sit inside it: Models first. Chat apps, Plugins and
// All OpenClaw settings join as parts here, never as rows of Settings' list. With one part the
// section opens straight on it; the parts' tabs show only once there are two.

import { type AccountsState, type Bot, type ConnectionState, type HostInfo } from "@clawtrate/core";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { SectionView } from "./AccountsSection.tsx";
import { useModelsSection } from "./ModelsSection.tsx";

/** The row's name in Settings' list, and the section's heading. */
export const OPENCLAW_SECTION_NAME = "OpenClaw";

/** One part of the section: its tab's name, and what it shows. */
export type OpenClawPart = { id: string; label: string; view: Pick<SectionView, "body" | "foot"> };

/**
 * The parts' tabs, a tab list that works by keyboard (arrows, Home and End move and choose,
 * as the tab pattern does) and at phone width (it wraps).
 */
export function PartTabs({
  parts,
  current,
  onChoose,
}: {
  parts: ReadonlyArray<Pick<OpenClawPart, "id" | "label">>;
  current: string;
  onChoose: (id: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = parts.findIndex((part) => part.id === current);
    const to =
      event.key === "ArrowRight"
        ? (at + 1) % parts.length
        : event.key === "ArrowLeft"
          ? (at - 1 + parts.length) % parts.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? parts.length - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    onChoose(parts[to]!.id);
    requestAnimationFrame(() =>
      list.current?.querySelector<HTMLElement>(`#openclaw-tab-${parts[to]!.id}`)?.focus(),
    );
  };
  return (
    <div
      ref={list}
      className="b-parts"
      role="tablist"
      aria-label={`${OPENCLAW_SECTION_NAME} settings`}
      onKeyDown={move}
    >
      {parts.map((part) => (
        <button
          key={part.id}
          type="button"
          role="tab"
          id={`openclaw-tab-${part.id}`}
          aria-selected={part.id === current}
          aria-controls={`openclaw-part-${part.id}`}
          tabIndex={part.id === current ? 0 : -1}
          className="b-part"
          onClick={() => onChoose(part.id)}
        >
          {part.label}
        </button>
      ))}
    </div>
  );
}

/** The section's body: the chosen part, under its tabs when there is more than one. */
export function partsBody(
  parts: readonly OpenClawPart[],
  current: string,
  tabs: ReactNode,
): ReactNode {
  const shown = parts.find((part) => part.id === current) ?? parts[0]!;
  if (parts.length < 2) return shown.view.body;
  return (
    <>
      {tabs}
      <div
        role="tabpanel"
        id={`openclaw-part-${shown.id}`}
        aria-labelledby={`openclaw-tab-${shown.id}`}
      >
        {shown.view.body}
      </div>
    </>
  );
}

export function useOpenClawSection(options: {
  accounts: AccountsState;
  bots: readonly Bot[];
  connection: ConnectionState;
  info: HostInfo;
  announce: (text: string) => void;
  toNav: ReactNode;
  showGatewayBot?: boolean;
}): SectionView {
  // Every part's hook runs on every render, so a part can be added without moving the others.
  const models = useModelsSection(options);
  const parts: OpenClawPart[] = [{ id: "models", label: "Models", view: models }];
  const [current, setCurrent] = useState(parts[0]!.id);
  const shown = parts.find((part) => part.id === current) ?? parts[0]!;
  const tabs = <PartTabs parts={parts} current={shown.id} onChoose={setCurrent} />;
  return {
    title: OPENCLAW_SECTION_NAME,
    back: options.toNav,
    body: partsBody(parts, shown.id, tabs),
    foot: shown.view.foot,
  };
}

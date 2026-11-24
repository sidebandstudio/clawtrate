import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export type MenuEntry =
  | {
      kind: "item";
      label: string;
      onSelect: () => void;
      /** Shown, reachable, and announced as unavailable; choosing it does nothing. */
      disabled?: boolean;
      tone?: "danger";
      icon?: ReactNode;
      hint?: string;
      /** A second line saying what the item does beyond its name; also its accessible description. */
      note?: string;
    }
  | {
      kind: "radio";
      label: string;
      checked: boolean;
      onSelect: () => void;
      note?: string;
      hint?: string;
    }
  | { kind: "head"; title: string; lines: string[] }
  | { kind: "label"; text: string }
  | { kind: "rule" };

/**
 * A menu: role `menu` with `menuitem`s and `menuitemradio`s. It opens with focus
 * on the checked item, or else the first. Up and Down move and wrap, Home and
 * End go to the ends, Enter or Space chooses. Escape closes it and asks for
 * focus to return to the trigger; Tab and a click outside close it.
 */
export function Menu({
  label,
  entries,
  onClose,
  className,
  style,
  trigger,
  focusAt,
}: {
  label: string;
  entries: MenuEntry[];
  /** `refocus` is true when focus should return to the control that opened the menu. */
  onClose: (refocus: boolean) => void;
  className?: string;
  style?: CSSProperties;
  /** Clicks on the trigger are the trigger's own; they do not count as outside. */
  trigger?: HTMLElement | null;
  /** When set or changed, focus moves to the item at this index: after items are added in place. */
  focusAt?: number;
}) {
  const ref = useRef<HTMLUListElement>(null);

  // Whether the menu had focus: true when focus lands in it, false when focus lands on anything
  // else. A focused row that is removed moves focus to the page with no focus event, so this still
  // says the menu had it; Tab from there to another control lands focus outside and clears it.
  const hasFocus = useRef(false);
  useLayoutEffect(() => {
    const menu = ref.current;
    const onFocusIn = (event: FocusEvent) => {
      hasFocus.current = menu?.contains(event.target as Node) ?? false;
    };
    document.addEventListener("focusin", onFocusIn, true);
    return () => document.removeEventListener("focusin", onFocusIn, true);
  }, []);
  // The menu may move focus only if it had it and focus is still in it or lost to the page: a
  // menu never takes focus from another control, whatever happened to its rows first.
  const mayMoveFocus = () => {
    const active = document.activeElement;
    return (
      hasFocus.current &&
      (!active || active === document.body || (ref.current?.contains(active) ?? false))
    );
  };

  // Both focus moves run as the entries change, in the same task, so a key pressed straight after
  // (Escape) finds focus in the menu.
  useLayoutEffect(() => {
    if (focusAt === undefined || !mayMoveFocus()) return;
    ref.current?.querySelectorAll<HTMLElement>(".menu-item")[focusAt]?.focus();
  }, [focusAt]);

  // A focused row that went away (its entries changed in place) leaves focus in the menu.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || !mayMoveFocus() || menu.contains(document.activeElement)) return;
    (
      menu.querySelector<HTMLElement>('[aria-checked="true"]') ??
      menu.querySelector<HTMLElement>(".menu-item")
    )?.focus();
  }, [entries]);

  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const first =
      menu.querySelector<HTMLElement>('[aria-checked="true"]') ??
      menu.querySelector<HTMLElement>(".menu-item");
    first?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.contains(target) || trigger?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [onClose, trigger]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(".menu-item") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    } else if (event.key === "Tab") {
      onClose(false);
      return;
    }
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus();
    }
  };

  return (
    <ul
      ref={ref}
      className={className ? `menu ${className}` : "menu"}
      role="menu"
      aria-label={label}
      style={style}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, index) => {
        switch (entry.kind) {
          case "head":
            return (
              <li key={index} className="menu-head" role="presentation">
                <strong>{entry.title}</strong>
                {entry.lines.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </li>
            );
          case "label":
            return (
              <li key={index} className="menu-label" role="presentation">
                {entry.text}
              </li>
            );
          case "rule":
            return <li key={index} className="menu-rule" role="separator" />;
          case "radio":
            return (
              <li key={index} role="none">
                <button
                  type="button"
                  className="menu-item"
                  role="menuitemradio"
                  aria-checked={entry.checked}
                  aria-label={entry.label}
                  aria-description={entry.note}
                  tabIndex={-1}
                  onClick={entry.onSelect}
                >
                  <span className="menu-item-text">
                    {entry.label}
                    {entry.note && <span className="menu-note">{entry.note}</span>}
                  </span>
                  {entry.hint && (
                    <kbd className="menu-hint" aria-hidden="true">
                      {entry.hint}
                    </kbd>
                  )}
                  <span className="glyph" data-state="check" aria-hidden="true" />
                </button>
              </li>
            );
          case "item":
            return (
              <li key={index} role="none">
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  data-tone={entry.tone}
                  aria-disabled={entry.disabled || undefined}
                  aria-label={entry.note ? entry.label : undefined}
                  aria-description={entry.note}
                  tabIndex={-1}
                  onClick={entry.disabled ? undefined : entry.onSelect}
                >
                  {entry.icon}
                  {entry.note ? (
                    <span className="menu-item-text">
                      {entry.label}
                      <span className="menu-note">{entry.note}</span>
                    </span>
                  ) : (
                    entry.label
                  )}
                  {entry.hint && (
                    <kbd className="menu-hint" aria-hidden="true">
                      {entry.hint}
                    </kbd>
                  )}
                </button>
              </li>
            );
        }
      })}
    </ul>
  );
}

import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";

export type MenuEntry =
  | { kind: "item"; label: string; onSelect: () => void; tone?: "danger" }
  | { kind: "radio"; label: string; checked: boolean; onSelect: () => void }
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
}: {
  label: string;
  entries: MenuEntry[];
  /** `refocus` is true when focus should return to the control that opened the menu. */
  onClose: (refocus: boolean) => void;
  className?: string;
  style?: CSSProperties;
  /** Clicks on the trigger are the trigger's own; they do not count as outside. */
  trigger?: HTMLElement | null;
}) {
  const ref = useRef<HTMLUListElement>(null);

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
                  tabIndex={-1}
                  onClick={entry.onSelect}
                >
                  {entry.label}
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
                  tabIndex={-1}
                  onClick={entry.onSelect}
                >
                  {entry.label}
                </button>
              </li>
            );
        }
      })}
    </ul>
  );
}

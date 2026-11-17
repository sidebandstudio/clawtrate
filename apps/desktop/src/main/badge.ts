// The dock or taskbar badge for unread activity. The renderer counts unread
// tasks and sends the number; the main process shows it. macOS and Linux show
// the count on the app's icon; Windows has no count, so it shows an overlay dot
// on the taskbar button, with the count in its description.

export type BadgeHost = {
  platform: string;
  setBadgeCount(count: number): unknown;
  /** Windows: set or clear the taskbar overlay on every window. */
  setOverlay(icon: "dot" | null, description: string): void;
};

/** An untrusted count from the renderer: a whole number from 0 to 9999, or nothing. */
export function parseBadgeCount(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 9999 ? raw : null;
}

export function applyUnreadBadge(host: BadgeHost, count: number): void {
  if (host.platform === "win32") {
    host.setOverlay(count > 0 ? "dot" : null, count > 0 ? `${count} unread` : "");
  } else {
    host.setBadgeCount(count);
  }
}

/** A filled circle as raw BGRA pixels, for the Windows overlay icon. */
export function dotBitmap(size: number, [r, g, b]: [number, number, number]): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const radius = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x + 0.5 - radius, y + 0.5 - radius);
      const alpha = Math.max(0, Math.min(1, radius - distance + 0.5));
      const at = (y * size + x) * 4;
      pixels[at] = b;
      pixels[at + 1] = g;
      pixels[at + 2] = r;
      pixels[at + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

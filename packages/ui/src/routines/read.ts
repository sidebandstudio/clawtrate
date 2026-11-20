import { useEffect, useState } from "react";

export type Read<T> =
  { status: "loading" } | { status: "error"; error: string } | { status: "ready"; value: T };

/**
 * A read the gateway answers, keyed by what it is for (gateway, routine,
 * revision): an answer is shown only while its key is the current one, so a
 * slower answer for something else never stands in for it. A null key reads
 * nothing. The second value reads again.
 */
export function useKeyedRead<T>(key: string | null, read: () => Promise<T>): [Read<T>, () => void] {
  const [answer, setAnswer] = useState<{ key: string; value: Read<T> } | null>(null);
  const [again, setAgain] = useState(0);
  // A retry is a read of its own: until it answers, the last one's error is not shown.
  const current = key === null ? null : `${key}#${again}`;
  useEffect(() => {
    if (current === null) return;
    let live = true;
    read().then(
      (value) => live && setAnswer({ key: current, value: { status: "ready", value } }),
      (error: unknown) =>
        live &&
        setAnswer({
          key: current,
          value: { status: "error", error: error instanceof Error ? error.message : String(error) },
        }),
    );
    return () => {
      live = false;
    };
    // `read` is new each render; the key says what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  return [
    answer !== null && answer.key === current ? answer.value : { status: "loading" },
    () => setAgain((n) => n + 1),
  ];
}

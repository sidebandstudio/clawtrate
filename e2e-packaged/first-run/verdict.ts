export const STEPS = [
  "clean-mac",
  "openclaw-not-found",
  "install-openclaw",
  "connect-with-full-control",
  "configure-scripted-provider",
  "first-bot-replies",
] as const;

export type Step = (typeof STEPS)[number];
export type StepResult = {
  step: Step;
  status: "passed" | "failed" | "not-reached";
  seconds: number;
  text: string | null;
  screenshot: string | null;
};

export function verdict(results: readonly StepResult[]): "passed" | "failed" {
  return STEPS.every((step, index) => {
    const result = results[index];
    return result?.step === step && result.status === "passed";
  }) && results.length === STEPS.length
    ? "passed"
    : "failed";
}

export type Element = { role: string; text: string };

export function forbiddenScreen(elements: readonly Element[]): string | null {
  const forbidden = elements.find(({ role, text }) => {
    if (role === "AXSystemDialog") {
      return (
        /\bcommand line (?:developer )?tools\b/i.test(text) &&
        /\b(?:install|download|required|requires)\b/i.test(text)
      );
    }
    if (/^AX(?:TextField|TextArea|SecureTextField|ComboBox)$/.test(role)) {
      return /\b(?:gateway address|(?:gateway |pairing |bootstrap )?token)\b/i.test(text);
    }
    if (role === "AXButton" && /^(Allow once|Always allow|Approve(?: device)?|Deny)$/i.test(text)) {
      return true;
    }
    return (
      /\b(?:approve this device|pairing (?:required|request|approval)|approval required|give this device full control)\b/i.test(
        text,
      ) || /\b(?:open|launch|use|run .+? in) (?:a |the |your )?terminal\b/i.test(text)
    );
  });
  return forbidden?.text ?? null;
}

// Model and effort, side by side (bots.md section 9): the models the gateway
// lists for the provider, unavailable ones shown and disabled, and the levels
// the gateway reports for the chosen model, or "Not offered" when it lists the
// model with none. A model its list does not contain keeps the effort last read.

import type { AccountsState } from "@clawtrate/core";
import { Select } from "./parts.tsx";
import { levelWord, modelsOf, noLevelsWord } from "./words.ts";

export function ModelPair({
  accounts,
  provider,
  model,
  effort,
  disabled,
  onModel,
  onEffort,
  placeholder,
}: {
  accounts: AccountsState;
  provider: string;
  model: string | null;
  effort: string | null;
  disabled: boolean;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
  /** Shown while no model is chosen: "Choose". */
  placeholder?: string;
}) {
  const models = modelsOf(accounts, provider);
  const levels = models.find((each) => each.id === model)?.levels ?? [];
  return (
    <div className="b-pair">
      <Select
        label="Model"
        value={model ?? placeholder ?? "Choose"}
        choices={models.map((each) => ({
          value: each.id,
          label: each.id,
          disabled: !each.available,
          ...(each.available ? {} : { note: "Not available" }),
        }))}
        onChoose={onModel}
        disabled={disabled}
        testId="model-select"
      />
      <Select
        label="Effort"
        value={levels.length === 0 ? noLevelsWord(models, model, effort) : (effort ?? levels[0]!)}
        choices={levels.map((level) => ({ value: level, label: levelWord(level) }))}
        onChoose={onEffort}
        disabled={disabled || levels.length === 0}
        testId="effort-select"
      />
    </div>
  );
}

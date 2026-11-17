import type { Bot } from "@clawtrate/core";

export function Avatar({
  bot,
  size = 30,
  badge = false,
}: {
  bot: Bot;
  size?: number;
  badge?: boolean;
}) {
  return (
    <span className="avatar" style={{ width: size, height: size }} aria-hidden="true">
      {bot.avatarUrl ? (
        <img src={bot.avatarUrl} alt="" draggable={false} />
      ) : (
        <span>{bot.emoji ?? bot.name.slice(0, 1).toUpperCase()}</span>
      )}
      {badge && bot.avatarUrl && bot.emoji && <span className="avatar-emoji">{bot.emoji}</span>}
    </span>
  );
}

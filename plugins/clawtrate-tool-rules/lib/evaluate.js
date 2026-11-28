// The plugin's decision for one tool call, in the order of the design
// (docs/design/controls.md, sections 3 and 21). A pure function of the rules
// and the call; the gateway's own denies and command checks are not here,
// because they are the gateway's (a tool it removed never reaches the hook,
// and exec meets its own command check after this one).
//
//   1. a matching Never, the bot's own rules first, then every bot's: block
//   2. a matching Ask, in the same order: ask
//   3. "Ask when nothing else decides" on for the bot or for every bot:
//      an Allow rule matching the call keeps it from asking (allow);
//      otherwise ask
//   4. otherwise no decision
//
// An Allow rule never passes an Ask or a Never, wherever either is set.
// `ask_user` is never asked about or blocked.

import { EVERY_BOT, EXEMPT_TOOL } from "./rules.js";
import { targetMatches, toolMatches } from "./targets.js";

/**
 * Whether a rule covers a call. A rule about what a tool acts on covers a
 * call whose target cannot be read (`value: null`) as if it acted on
 * everything: a Never or an Ask does, an Allow does not. A Never or an Ask
 * about a path matches any spelling of the path that reaches the same file;
 * an Allow only the path as given.
 */
export function ruleMatches(rule, call) {
  if (!rule.tools.some((entry) => toolMatches(entry, call.tool))) return false;
  if (!rule.target) return true;
  const target = call.target;
  if (!target || target.kind !== rule.target.kind || target.value === null) {
    return rule.action !== "allow";
  }
  // A Never or an Ask catches every spelling that reaches the same file; an Allow, the one given.
  return targetMatches(
    rule.target.kind,
    rule.target.pattern,
    target.value,
    rule.action !== "allow",
  );
}

const sourceOf = (scopeId, rule) => ({
  kind: "rule",
  scope: scopeId,
  ruleId: rule.id,
  version: rule.version,
  action: rule.action,
});

/**
 * The decision for `call` = `{agentId, tool, target}` under `scopes`, a map
 * of scope id to `{fallback, rules}`. Returns `{decision, source, rule?}`:
 * decision "block", "ask", "allow" (an Allow rule kept the fallback from
 * asking) or "none"; source the deciding rule as `{kind: "rule", scope,
 * ruleId, version, action}`, `{kind: "fallback", scope}`, or null.
 */
export function evaluate(scopes, call) {
  if (call.tool === EXEMPT_TOOL) return { decision: "none", source: null };
  const order = [call.agentId, EVERY_BOT]
    .filter((id, i, all) => typeof id === "string" && all.indexOf(id) === i)
    .map((id) => [id, scopes.get(id)])
    .filter(([, scope]) => scope);
  for (const [action, decision] of [
    ["never", "block"],
    ["ask", "ask"],
  ]) {
    for (const [scopeId, scope] of order) {
      const rule = scope.rules.find((r) => r.action === action && ruleMatches(r, call));
      if (rule) return { decision, source: sourceOf(scopeId, rule), rule };
    }
  }
  const asking = order.find(([, scope]) => scope.fallback);
  if (!asking) return { decision: "none", source: null };
  for (const [scopeId, scope] of order) {
    const rule = scope.rules.find((r) => r.action === "allow" && ruleMatches(r, call));
    if (rule) return { decision: "allow", source: sourceOf(scopeId, rule), rule };
  }
  return { decision: "ask", source: { kind: "fallback", scope: asking[0] } };
}

/**
 * Whether what a call acts on could change its decision from running without
 * a card: a Never or an Ask about what the tool acts on, or, with "Ask when
 * nothing else decides" on, an Allow about it. A call another plugin rewrites
 * after the decision could reach such a rule unseen.
 */
export function targetDecides(scopes, call) {
  const order = [call.agentId, EVERY_BOT]
    .filter((id, i, all) => typeof id === "string" && all.indexOf(id) === i)
    .map((id) => scopes.get(id))
    .filter(Boolean);
  const fallback = order.some((scope) => scope.fallback);
  return order.some((scope) =>
    scope.rules.some(
      (rule) =>
        rule.target &&
        rule.tools.some((entry) => toolMatches(entry, call.tool)) &&
        (rule.action !== "allow" || fallback),
    ),
  );
}

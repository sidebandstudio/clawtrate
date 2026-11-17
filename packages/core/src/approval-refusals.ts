// Which answers to a decision on an approval establish that the decision was
// not applied. Only an answer the gateway gives before it touches the
// decision counts; every other error, including any this list does not name,
// leaves the outcome unknown until the request is read back (`checkApproval`).
//
// Sources are OpenClaw 2026.10.6, as installed (`dist/`). An answer is named
// by its structured fields wherever the gateway gives them; two are named by
// their message, because the gateway gives nothing else for them, and only
// for the methods whose handler stops before deciding when it sends them.

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { asRecord } from "./mapping.ts";

export type RefusedDecisionAnswer = {
  /** What the answer is, as the gateway sends it. */
  answer: string;
  /** Why it establishes that the decision was not applied. */
  why: string;
  /** Where the gateway sends it. */
  source: string;
  matches: (error: GatewayProtocolRequestError, method: string) => boolean;
};

const reasonOf = (error: GatewayProtocolRequestError) => asRecord(error.details)?.reason;
const codeOf = (error: GatewayProtocolRequestError) => asRecord(error.details)?.code;
/** The legacy methods, whose handler validates parameters and the decision before resolving. */
const LEGACY = new Set(["exec.approval.resolve", "plugin.approval.resolve"]);

export const REFUSED_DECISION_ANSWERS: readonly RefusedDecisionAnswer[] = [
  {
    answer: "FORBIDDEN with details.code MISSING_SCOPE",
    why: "method authorization refuses the request before any handler runs",
    source:
      "request-authorization-CUsX09Ar.mjs:388 (authorizeGatewayMethod), shaped by error-codes-CWpzrMTj.mjs:96 (missingScopeErrorShape)",
    matches: (error) => error.gatewayCode === "FORBIDDEN" && codeOf(error) === "MISSING_SCOPE",
  },
  {
    answer: "INVALID_REQUEST with details.reason APPROVAL_ALREADY_RESOLVED",
    why: "the request was already settled with another decision; this one was not applied",
    source:
      "approval-shared-0z4gkxmd.mjs:87 and :281 (respondRepeatedApprovalResolution), reached at :341 and :392",
    matches: (error) =>
      error.gatewayCode === "INVALID_REQUEST" && reasonOf(error) === "APPROVAL_ALREADY_RESOLVED",
  },
  {
    answer: "INVALID_REQUEST with details.reason APPROVAL_ALLOW_ALWAYS_UNAVAILABLE",
    why: "exec's decision check refuses a decision the request does not offer, before resolving",
    source: "exec-approval-DAaiZN5X.mjs:117 and :482, checked at approval-shared-0z4gkxmd.mjs:350",
    matches: (error) =>
      error.gatewayCode === "INVALID_REQUEST" &&
      reasonOf(error) === "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE",
  },
  {
    answer: "INVALID_REQUEST with details.allowedDecisions, from plugin.approval.resolve",
    why: "the plugin's decision check refuses a decision the request does not offer, before resolving",
    source: "plugin-approval-B3Gyyexn.mjs:186, checked at approval-shared-0z4gkxmd.mjs:350",
    matches: (error, method) =>
      method === "plugin.approval.resolve" &&
      error.gatewayCode === "INVALID_REQUEST" &&
      Array.isArray(asRecord(error.details)?.allowedDecisions),
  },
  {
    answer: "INVALID_REQUEST `invalid <method> params: …`, from the legacy methods",
    why: "parameter validation answers before the handler looks the request up",
    source:
      "validation-oIBG8t4e.mjs:7 (validateGatewayMethodParams), via approval-shared-0z4gkxmd.mjs:128, in resolveApprovalDecisionParams (:126)",
    matches: (error, method) =>
      LEGACY.has(method) &&
      error.gatewayCode === "INVALID_REQUEST" &&
      error.message.startsWith(`invalid ${method} params:`),
  },
  {
    answer: "INVALID_REQUEST `invalid decision`, from the legacy methods",
    why: "the decision is checked before the handler looks the request up",
    source: "approval-shared-0z4gkxmd.mjs:130 (resolveApprovalDecisionParams)",
    matches: (error, method) =>
      LEGACY.has(method) &&
      error.gatewayCode === "INVALID_REQUEST" &&
      error.message === "invalid decision",
  },
];

/**
 * Whether an error answering a decision sent with `method` establishes that
 * the decision was not applied. Not on this list, and so unknown: UNAVAILABLE
 * (`approval-shared-0z4gkxmd.mjs:101`, also sent when committing the decision
 * failed after it may have been applied, `exec-approval-lifecycle-C2ICZaCU.mjs:44` and `:71`);
 * `unknown or expired approval id` (`approval-record-lookup-o5fS3cNj.mjs:123`,
 * also sent after a decision was applied when the resolver's authority lapsed,
 * `approval-shared-0z4gkxmd.mjs:413`); the generic `approval.resolve`'s
 * invalid parameters, which it turns into a deny (`approval-DIiWwPng.mjs:380`);
 * and anything else.
 */
export function isRefusedDecision(method: string, error: unknown): boolean {
  if (!(error instanceof GatewayProtocolRequestError)) return false;
  return REFUSED_DECISION_ANSWERS.some((each) => each.matches(error, method));
}

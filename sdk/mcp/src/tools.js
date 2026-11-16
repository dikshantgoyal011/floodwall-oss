// What each tool does, apart from the MCP plumbing: plain functions over a
// @floodwall/client `Floodwall`, each returning `{ text, isError? }`.

import { FloodwallError } from "@floodwall/client";

/** Statuses after which the agent may go ahead with the change. */
const ADMITTED = new Set(["admit", "in_flight"]);

export const keyToString = (key) => `${key.agent}/${key.id}`;

/** "agent/id" back into a key; the id is everything after the last slash. */
export function parseKey(text) {
  const at = String(text).lastIndexOf("/");
  if (at <= 0 || at === text.length - 1) throw new TypeError('key must look like "agent/id", as submit_intent returned it');
  return { agent: text.slice(0, at), id: text.slice(at + 1) };
}

/** What the model is told about a decision: a verdict, and what to do next. */
export function describe(decision) {
  const proceed = ADMITTED.has(decision.status);
  const key = keyToString(decision.key);
  let next;
  if (proceed) {
    next = `Admitted. You may make the change now. Afterwards call report_outcome with key "${key}" and succeeded or failed.`;
  } else if (decision.status === "queued") {
    next = `Not decided yet. Do NOT make the change. Call wait_verdict with key "${key}" to wait for the answer.`;
  } else if (decision.status === "held") {
    next = `Held for a person to approve. Do NOT make the change and do not retry it. Tell the user it is waiting for approval; wait_verdict with key "${key}" can wait for their answer.`;
  } else {
    next = `Not admitted (${decision.status}). Do NOT make the change and do not retry the same change. Tell the user why.`;
  }
  return {
    key,
    status: decision.status,
    proceed,
    reason: decision.reason,
    policies: decision.policies.filter((p) => p.verdict !== "admit"),
    next,
  };
}

const json = (value) => ({ text: JSON.stringify(value, null, 2) });

/** A failure the model can read. Never throws, so a refusal is never the end of the conversation. */
function failure(error) {
  if (error instanceof FloodwallError) {
    const hint =
      error.status === 403
        ? " (this key may not do that; list_held needs an operator key)"
        : error.status === 401
          ? " (the API key, agent name or signature was refused)"
          : "";
    return { isError: true, text: `Floodwall refused the request: ${error.status} ${error.message}${hint}. Do NOT make the change.` };
  }
  if (error instanceof TypeError && /key must look like|context|scale|priority|blastRadius|action/.test(error.message)) {
    return { isError: true, text: `Invalid request: ${error.message}. Fix the arguments and call again; do NOT make the change yet.` };
  }
  return {
    isError: true,
    text: `Floodwall could not be reached (${error?.message ?? error}). Treat the change as NOT admitted: do NOT make it.`,
  };
}

export async function submitIntent(fw, args) {
  try {
    const action = { kind: args.kind, resource: args.resource };
    if (args.kind === "scale") action.replicas = args.replicas;
    if (args.kind === "apply") action.manifest = args.manifest ?? "";
    const decision = await fw.submit({
      action,
      priority: args.priority,
      blastRadius: args.blast_radius,
      context: args.context,
    });
    return json(describe(decision));
  } catch (error) {
    return failure(error);
  }
}

export async function waitVerdict(fw, args) {
  try {
    const seconds = Math.min(Math.max(args.wait ?? 30, 0), 120);
    return json(describe(await fw.wait(parseKey(args.key), { timeoutSeconds: seconds })));
  } catch (error) {
    return failure(error);
  }
}

export async function reportOutcome(fw, args) {
  try {
    await fw.report(parseKey(args.key), args.outcome, args.reason);
    return json({ key: args.key, reported: args.outcome });
  } catch (error) {
    return failure(error);
  }
}

export async function listHeld(fw) {
  try {
    const answer = await fw.request("GET", `/v1/planes/${encodeURIComponent(fw.plane)}/held`);
    const held = (answer.held ?? []).map((h) => ({
      key: h.key ? keyToString(h.key) : undefined,
      intent: h.intent,
      since: h.since,
      reason: h.reason,
      explanation: h.explanation?.text ?? null,
    }));
    return json({ held, count: held.length });
  } catch (error) {
    return failure(error);
  }
}

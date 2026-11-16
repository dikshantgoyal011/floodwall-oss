// Floodwall for the Claude Agent SDK (@anthropic-ai/claude-agent-sdk): hooks
// that ask the plane before a risky Bash command and report the outcome.
//
//   import { query } from "@anthropic-ai/claude-agent-sdk";
//   import { claudeAgentSdkHooks } from "@floodwall/mcp/agent-sdk";
//   query({ prompt, options: { hooks: claudeAgentSdkHooks({ client }) } });

import { handleHook } from "./hook.js";

/**
 * The `hooks` option for `query()`.
 *
 * @param {object} [options]
 * @param {import("@floodwall/client").Floodwall} [options.client] defaults to one built from FLOODWALL_* in `env`
 * @param {NodeJS.ProcessEnv} [options.env] hook settings (patterns, blast radius, fail-open) are read from here too
 * @param {string} [options.matcher] tool name matcher, "Bash" by default
 * @param {number} [options.waitSeconds] how long a held change is waited for; sets FLOODWALL_HOOK_WAIT
 */
export function claudeAgentSdkHooks({ client, env = process.env, matcher = "Bash", waitSeconds } = {}) {
  const settings = waitSeconds === undefined ? env : { ...env, FLOODWALL_HOOK_WAIT: String(waitSeconds) };
  const run = (event) => async (input) => {
    const deny = (reason) => ({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    });
    try {
      const result = await handleHook({ ...input, hook_event_name: input?.hook_event_name ?? event }, { client, env: settings });
      return result.block ? deny(result.block) : {};
    } catch (error) {
      // Fail closed on anything unexpected, unless fail-open was asked for.
      if (event !== "PreToolUse" || settings.FLOODWALL_FAIL_OPEN === "1") return {};
      return deny(`Blocked by Floodwall: hook error (${error?.message ?? error})`);
    }
  };
  // A held change is waited for inside the callback, so give it room beyond the wait.
  const timeout = Math.ceil(Number(settings.FLOODWALL_HOOK_WAIT ?? 60)) + 30;
  return {
    PreToolUse: [{ matcher, hooks: [run("PreToolUse")], timeout }],
    PostToolUse: [{ matcher, hooks: [run("PostToolUse")] }],
    PostToolUseFailure: [{ matcher, hooks: [run("PostToolUseFailure")] }],
  };
}

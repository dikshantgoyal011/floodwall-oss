import type { Floodwall } from "@floodwall/client";

// Shapes follow @anthropic-ai/claude-agent-sdk's hooks option; it is an optional peer dependency.
export interface FloodwallHookMatcher {
  matcher?: string;
  hooks: Array<(input: any, toolUseID?: string, context?: { signal: AbortSignal }) => Promise<Record<string, unknown>>>;
  /** Seconds. */
  timeout?: number;
}

export interface FloodwallAgentSdkHooks {
  PreToolUse: FloodwallHookMatcher[];
  PostToolUse: FloodwallHookMatcher[];
  PostToolUseFailure: FloodwallHookMatcher[];
}

export interface ClaudeAgentSdkHooksOptions {
  /** Defaults to a client built from FLOODWALL_API_KEY, FLOODWALL_PLANE and FLOODWALL_URL in `env`. */
  client?: Floodwall;
  /** Read for FLOODWALL_* settings. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Tool-name matcher. Defaults to "Bash". */
  matcher?: string;
  /** Seconds to wait for a held change before blocking. Defaults to 60. */
  waitSeconds?: number;
}

/** The `hooks` option for the Claude Agent SDK's `query()`: blocks risky Bash commands unless the plane admits them. */
export declare function claudeAgentSdkHooks(options?: ClaudeAgentSdkHooksOptions): FloodwallAgentSdkHooks;

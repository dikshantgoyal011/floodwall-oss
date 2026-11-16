/** The most `context` a submit may carry, in UTF-8 bytes. */
export declare const MAX_CONTEXT_BYTES: number;
export type Priority = "bulk" | "normal" | "urgent" | "pager";
export type BlastRadius = "cell" | "service" | "region" | "global";
export type Action =
  | { kind: "apply"; resource: string; manifest: string }
  | { kind: "scale"; resource: string; replicas: number }
  | { kind: "destroy"; resource: string };

/** A change as the caller describes it. */
export interface Change {
  action: Action;
  /** Defaults to "normal". */
  priority?: Priority;
  /** Defaults to "service". */
  blastRadius?: BlastRadius;
  /** Defaults to a new id above every id this client has used. */
  id?: number | string;
  /**
   * A diff or plan, up to 64 KiB of UTF-8, for the plane's AI review. Sent as a top-level `context`
   * field with the intent; never signed and never stored by the plane.
   */
  context?: string;
}

/** An intent in the plane's own form. */
export interface Intent {
  id: string;
  agent: string;
  action: Action;
  priority: Priority;
  blast_radius: BlastRadius;
  signature: string | null;
}

export interface IntentKey {
  agent: string;
  id: string;
}

export interface Decision {
  key: IntentKey;
  /** "admit" or "in_flight" once admitted; "queued" and "held" while waiting; else "rejected", "expired", "lapsed", "done". */
  status: string;
  verdict: "admit" | "defer" | "reject" | null;
  reason: string | null;
  policies: { policy: string; verdict: string; reason: string | null }[];
}

export interface FloodwallOptions {
  apiKey: string;
  plane: string;
  agent: string;
  /** Must be https:// unless the host is localhost, 127.0.0.1 or [::1]. */
  baseUrl?: string;
  whenUnreachable?: "closed" | "open";
  /** Told about each change applied unchecked. The default logs agent, kind, resource and error, never the manifest. */
  onFailOpen?: (intent: Intent, error: unknown) => void;
  signingKey?: CryptoKey | Uint8Array;
  /** Told when reporting a successful change failed; the result is still returned. Defaults to console.warn. */
  onReportError?: (error: unknown, key: IntentKey) => void;
  fetch?: typeof fetch;
  /** For tests: how `wait` pauses between polls. */
  sleep?: (ms: number) => Promise<void>;
}

export declare class Floodwall {
  constructor(options: FloodwallOptions);
  nextId(): number;
  intent(change: Change): Intent;
  submit(change: Change | Intent): Promise<Decision>;
  wait(key: IntentKey, options?: { timeoutSeconds?: number }): Promise<Decision>;
  report(key: IntentKey, outcome: "succeeded" | "failed", reason?: string): Promise<void>;
  prepare(change: Change | Intent): Promise<Intent>;
  /** If `apply` throws and the failure report fails too, the apply error is thrown with `reportError` set. */
  guard<T>(change: Change | Intent, apply: () => T | Promise<T>, options?: { timeoutSeconds?: number }): Promise<T>;
}

/**
 * When `decision.status` is "held" after a timeout, the intent is still held and may be released later:
 * do not apply the change afterwards without submitting it again.
 */
export declare class NotAdmitted extends Error {
  decision: Decision;
}

export declare class FloodwallError extends Error {
  status: number;
  body: unknown;
}

export declare function intentBytes(intent: Intent): Uint8Array;
export declare function intentDigest(intent: Intent): Promise<Uint8Array>;
export declare function sign(intent: Intent, key: CryptoKey | Uint8Array): Promise<string>;

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
  baseUrl?: string;
  whenUnreachable?: "closed" | "open";
  onFailOpen?: (change: Change | Intent, error: unknown) => void;
  signingKey?: CryptoKey | Uint8Array;
  fetch?: typeof fetch;
}

export declare class Floodwall {
  constructor(options: FloodwallOptions);
  nextId(): number;
  intent(change: Change): Intent;
  submit(change: Change | Intent): Promise<Decision>;
  wait(key: IntentKey, options?: { timeoutSeconds?: number }): Promise<Decision>;
  report(key: IntentKey, outcome: "succeeded" | "failed", reason?: string): Promise<void>;
  guard<T>(change: Change | Intent, apply: () => T | Promise<T>, options?: { timeoutSeconds?: number }): Promise<T>;
}

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

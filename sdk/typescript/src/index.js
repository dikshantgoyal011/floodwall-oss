// @floodwall/client: ask a Floodwall Cloud plane before an agent changes
// production, and tell it how the change went.
//
// No dependencies: it uses the platform's fetch and, to sign intents,
// WebCrypto's Ed25519 (Node 20+, Deno, Bun, Workers, current browsers).

const DEFAULT_BASE_URL = "https://api.floodwall.ai";
const PRIORITIES = ["bulk", "normal", "urgent", "pager"];
const BLAST_RADII = ["cell", "service", "region", "global"];
/** Statuses an intent can still leave without anyone acting on it. */
const WAITING = new Set(["queued", "held"]);
/** Polls of a waiting intent are never closer together than this, whatever the server does. */
const MIN_POLL_MS = 1000;
/** A 429's Retry-After is waited out up to this, however long it asks for. */
const MAX_RETRY_AFTER_SECONDS = 60;
const MAX_REASON = 1024;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The plane did not admit the change: it was rejected, expired or lapsed, or still waited when time ran out.
 * When `decision.status` is "held" (or "queued") after a timeout, the intent is still held on the plane and
 * may be released later. The agent must not apply the change afterwards without submitting it again.
 */
export class NotAdmitted extends Error {
  constructor(decision) {
    super(
      decision.reason
        ? `floodwall did not admit ${decision.key.agent}/${decision.key.id}: ${decision.status}: ${decision.reason}`
        : `floodwall did not admit ${decision.key.agent}/${decision.key.id}: ${decision.status}`,
    );
    this.name = "NotAdmitted";
    this.decision = decision;
  }
}

/** The plane answered with an error the caller should not retry blindly. */
export class FloodwallError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "FloodwallError";
    this.status = status;
    this.body = body;
  }
}

/**
 * A connection to one plane, as one agent.
 *
 * @param {object} options
 * @param {string} options.apiKey An agent (or operator) key for the plane, `fw_live_…` or `fw_test_…`.
 * @param {string} options.plane The plane's id.
 * @param {string} options.agent The agent's name, as the plane's rules and ledger know it.
 * @param {string} [options.baseUrl] Defaults to https://api.floodwall.ai.
 * @param {"closed"|"open"} [options.whenUnreachable] What `guard` does when the plane cannot be reached:
 *   "closed" (the default) refuses the change; "open" applies it unchecked and calls `onFailOpen`.
 * @param {(intent: object, error: Error) => void} [options.onFailOpen] Told about each change applied unchecked.
 * @param {CryptoKey|Uint8Array} [options.signingKey] The agent's Ed25519 private key (or its 32-byte seed),
 *   for planes that require signed intents.
 * @param {(error: Error, key: {agent: string, id: string}) => void} [options.onReportError] Told when reporting
 *   a successful change failed (the result is still returned). Defaults to a console.warn without the manifest.
 * @param {typeof fetch} [options.fetch] For tests.
 * @param {(ms: number) => Promise<void>} [options.sleep] For tests.
 *
 * `baseUrl` must be https:// unless the host is localhost, 127.0.0.1 or [::1].
 */
export class Floodwall {
  constructor(options) {
    for (const name of ["apiKey", "plane", "agent"]) {
      if (typeof options?.[name] !== "string" || !options[name]) throw new TypeError(`${name} is required`);
    }
    // Not enumerable, so logging or serializing the client does not print the key.
    Object.defineProperty(this, "apiKey", { value: options.apiKey, enumerable: false, writable: true, configurable: true });
    this.plane = options.plane;
    this.agent = options.agent;
    this.baseUrl = withoutTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
    checkBaseUrl(this.baseUrl);
    this.whenUnreachable = options.whenUnreachable ?? "closed";
    if (this.whenUnreachable !== "closed" && this.whenUnreachable !== "open") {
      throw new TypeError('whenUnreachable must be "closed" or "open"');
    }
    this.onFailOpen =
      options.onFailOpen ??
      ((intent, error) =>
        console.warn(
          `floodwall unreachable; applied unchecked: agent=${intent.agent} kind=${intent.action?.kind} resource=${intent.action?.resource}: ${error?.message ?? error}`,
        ));
    this.onReportError =
      options.onReportError ??
      ((error, key) => console.warn(`floodwall could not report the outcome of ${key.agent}/${key.id}: ${error?.message ?? error}`));
    Object.defineProperty(this, "signingKey", { value: options.signingKey, enumerable: false, writable: true, configurable: true });
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.lastId = 0;
  }

  /**
   * An id above every id this client has used: the time in microseconds, or one more than the last.
   * Planes refuse an agent's signed ids that do not increase, so a restarted agent needs no saved state.
   */
  nextId() {
    this.lastId = Math.max(this.lastId + 1, Date.now() * 1000);
    return this.lastId;
  }

  /**
   * The intent in the plane's form. `action` is `{kind:"apply", resource, manifest}`,
   * `{kind:"scale", resource, replicas}` or `{kind:"destroy", resource}`.
   */
  intent({ action, priority = "normal", blastRadius = "service", id }) {
    if (!PRIORITIES.includes(priority)) throw new TypeError(`priority must be one of ${PRIORITIES.join(", ")}`);
    if (!BLAST_RADII.includes(blastRadius)) throw new TypeError(`blastRadius must be one of ${BLAST_RADII.join(", ")}`);
    let normalized;
    switch (action?.kind) {
      case "apply":
        normalized = { kind: "apply", resource: String(action.resource), manifest: String(action.manifest ?? "") };
        break;
      case "scale":
        if (!Number.isInteger(action.replicas) || action.replicas < 0 || action.replicas > 0xffffffff) {
          throw new TypeError("scale replicas must be a whole number from 0 to 4294967295");
        }
        normalized = { kind: "scale", resource: String(action.resource), replicas: action.replicas };
        break;
      case "destroy":
        normalized = { kind: "destroy", resource: String(action.resource) };
        break;
      default:
        throw new TypeError('action.kind must be "apply", "scale" or "destroy"');
    }
    return {
      id: String(id ?? this.nextId()),
      agent: this.agent,
      action: normalized,
      priority,
      blast_radius: blastRadius,
      signature: null,
    };
  }

  /** Validate (and sign, when there is a key) a change: errors here are the caller's, never "unreachable". */
  async prepare(change) {
    const intent = "agent" in change && "blast_radius" in change ? change : this.intent(change);
    if (this.signingKey) intent.signature = await sign(intent, this.signingKey);
    return intent;
  }

  /** Offer a change. Resolves to the plane's first answer: admit, defer (held), reject, or queued. */
  async submit(change) {
    return this.post(await this.prepare(change));
  }

  async post(intent) {
    const answer = await this.request("POST", `/v1/planes/${enc(this.plane)}/intents`, intent);
    return decision(answer, intent);
  }

  /**
   * Wait until the intent leaves the queue and the hold queue (it is admitted, rejected, expired or lapsed),
   * or `timeoutSeconds` pass. Resolves to its latest status either way. A timeout leaves the intent held.
   * Polls are at least a second apart even if the server answers at once.
   */
  async wait(key, { timeoutSeconds = 300 } = {}) {
    const until = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      const started = Date.now();
      const left = Math.ceil((until - started) / 1000);
      const wait = Math.max(0, Math.min(20, left));
      const answer = await this.request(
        "GET",
        `/v1/planes/${enc(this.plane)}/intents/${enc(key.agent)}/${enc(key.id)}?wait=${wait}`,
      );
      const status = decision(answer, null, key);
      if (!WAITING.has(status.status) || left <= 0) return status;
      const pause = Math.min(MIN_POLL_MS - (Date.now() - started), until - Date.now());
      if (pause > 0) await this.sleep(pause);
    }
  }

  /** Report how an admitted change went, which frees its resource for the next change. */
  async report(key, outcome, reason) {
    if (outcome !== "succeeded" && outcome !== "failed") throw new TypeError('outcome must be "succeeded" or "failed"');
    await this.request(
      "POST",
      `/v1/planes/${enc(this.plane)}/intents/${enc(key.agent)}/${enc(key.id)}/outcome`,
      { outcome, reason: reason == null ? null : String(reason).replace(/\s+/g, " ").trim().slice(0, MAX_REASON) },
    );
  }

  /**
   * Run `apply` only if the plane admits the change, and report the outcome, failures included.
   * Throws NotAdmitted when it is not admitted (a "held" intent after a timeout may still be released later;
   * do not apply the change then without submitting it again). Rethrows what `apply` throws after reporting it
   * failed; if that report fails too, the apply error is still the one thrown, with the report error on its
   * `reportError` property. If `apply` succeeds but the report fails, the result is returned and `onReportError` told.
   * Only transport failures and 5xx count as unreachable; invalid changes and signing errors always throw.
   */
  async guard(change, apply, { timeoutSeconds = 300 } = {}) {
    const intent = await this.prepare(change);
    let first;
    try {
      first = await this.post(intent);
    } catch (error) {
      if (this.whenUnreachable === "open" && unreachable(error)) {
        this.onFailOpen(intent, error);
        return apply();
      }
      throw error;
    }
    const settled = WAITING.has(first.status) ? await this.wait(first.key, { timeoutSeconds }) : first;
    if (settled.status !== "in_flight" && settled.status !== "admit") throw new NotAdmitted(settled);
    let result;
    try {
      result = await apply();
    } catch (error) {
      try {
        await this.report(first.key, "failed", String(error?.message ?? error));
      } catch (reportError) {
        try {
          Object.defineProperty(error, "reportError", { value: reportError, enumerable: false, configurable: true, writable: true });
        } catch {
          // A thrown primitive or frozen object cannot carry it; the apply error still wins.
        }
      }
      throw error;
    }
    try {
      await this.report(first.key, "succeeded");
    } catch (reportError) {
      this.onReportError(reportError, first.key);
    }
    return result;
  }

  async request(method, path, body) {
    let response;
    for (let attempt = 0; ; attempt++) {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A redirect is an error: the API key must not follow a response to another place.
        redirect: "error",
      });
      // Rate limited or the queue is full: wait as told (a minute at most), a few times.
      if (response.status === 429 && attempt < 5) {
        const seconds = Number(response.headers.get("Retry-After")) || 1;
        await this.sleep(Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER_SECONDS) * 1000);
        continue;
      }
      break;
    }
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: text };
    }
    if (!response.ok && response.status !== 202) {
      throw new FloodwallError(response.status, parsed.error ?? `floodwall answered ${response.status}`, parsed);
    }
    return parsed;
  }
}

/** The URL with any slashes at its end taken off; a loop, so no input makes it slow. */
function withoutTrailingSlashes(url) {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}

function enc(value) {
  return encodeURIComponent(String(value));
}

/** Only a transport failure (fetch's TypeError, an abort or timeout) or a 5xx means the plane is unreachable. */
function unreachable(error) {
  if (error instanceof FloodwallError) return error.status >= 500;
  return error instanceof TypeError || error?.name === "AbortError" || error?.name === "TimeoutError";
}

function checkBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new TypeError("baseUrl must be https:// unless the host is localhost, 127.0.0.1 or [::1]");
  }
}

/** The plane's answer as `{key, status, verdict, reason}`; `status` is "admit", "queued", "held", "in_flight", … */
function decision(answer, intent, key) {
  const k = answer.key ?? key ?? { agent: intent.agent, id: intent.id };
  const status = answer.status ?? answer.verdict ?? "queued";
  return {
    key: { agent: k.agent, id: String(k.id) },
    status: status === "defer" ? "held" : status === "reject" ? "rejected" : status,
    verdict: answer.verdict ?? null,
    reason: answer.reason ?? null,
    policies: answer.policies ?? [],
  };
}

// --- Signing (see the crate's Intent docs: "Signing") ---

function field(parts, bytes) {
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(bytes.length), true);
  parts.push(length, bytes);
}

/** The bytes whose SHA-256 an agent signs: every field but the signature. */
export function intentBytes(intent) {
  const utf8 = (s) => new TextEncoder().encode(s);
  const parts = [];
  field(parts, utf8("floodwall/intent/v1"));
  field(parts, utf8(intent.agent));
  const id = new Uint8Array(8);
  new DataView(id.buffer).setBigUint64(0, BigInt(intent.id), true);
  parts.push(id);
  const a = intent.action;
  if (a.kind === "apply") {
    parts.push(Uint8Array.of(0));
    field(parts, utf8(a.resource));
    field(parts, utf8(a.manifest));
  } else if (a.kind === "scale") {
    parts.push(Uint8Array.of(1));
    field(parts, utf8(a.resource));
    const r = new Uint8Array(4);
    new DataView(r.buffer).setUint32(0, a.replicas, true);
    parts.push(r);
  } else {
    parts.push(Uint8Array.of(2));
    field(parts, utf8(a.resource));
  }
  parts.push(Uint8Array.of(PRIORITIES.indexOf(intent.priority), BLAST_RADII.indexOf(intent.blast_radius)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The intent's digest, as the plane computes it. */
export async function intentDigest(intent) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", intentBytes(intent)));
}

// PKCS#8 wrapping for a raw 32-byte Ed25519 seed (RFC 8410).
const PKCS8_ED25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

async function privateKey(key) {
  if (!(key instanceof Uint8Array)) return key;
  if (key.length !== 32) throw new TypeError("an Ed25519 seed is 32 bytes");
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_ED25519);
  pkcs8.set(key, 16);
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}

/** The intent's signature as lowercase hex. */
export async function sign(intent, key) {
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await privateKey(key), await intentDigest(intent)));
  return Array.from(signature, (b) => b.toString(16).padStart(2, "0")).join("");
}

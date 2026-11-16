// The MCP server: four tools over one plane.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_CONTEXT_BYTES } from "@floodwall/client";
import { listHeld, reportOutcome, submitIntent, waitVerdict } from "./tools.js";

const KEY = z.string().describe('The intent key exactly as submit_intent returned it, like "my-agent/1731700000000000".');

const toResult = ({ text, isError }) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

/** An McpServer wired to `fw` (a `Floodwall` client). */
export function createServer(fw, { name = "floodwall", version = "0.1.0" } = {}) {
  const server = new McpServer({ name, version });

  server.registerTool(
    "submit_intent",
    {
      title: "Ask Floodwall before changing production",
      description:
        "Ask the Floodwall change-control plane for permission BEFORE you make any change to infrastructure or production " +
        "(deploying, applying a manifest, scaling, deleting or destroying anything). Submit first, act second. " +
        "Proceed ONLY if the answer says proceed: true (status \"admit\"). If the status is anything else (held, queued, " +
        "rejected, expired, lapsed) or the call fails, STOP: do not make the change, do not retry it, do not look for another " +
        "way to do it, and tell the user what the plane said. After you make an admitted change, call report_outcome. " +
        "kind is apply (roll out a manifest or image), scale (set replicas) or destroy (delete). Put a diff or plan in context when you have one.",
      inputSchema: {
        kind: z.enum(["apply", "scale", "destroy"]).describe("What the change does."),
        resource: z.string().min(1).describe('What it changes, such as "web" or "deployment/orders" or a terraform workspace.'),
        replicas: z.number().int().min(0).optional().describe("Required for scale: the replica count to set."),
        manifest: z.string().optional().describe("For apply: the manifest, image or version being rolled out."),
        priority: z.enum(["bulk", "normal", "urgent", "pager"]).default("normal").describe("How urgent the change is."),
        blast_radius: z.enum(["cell", "service", "region", "global"]).default("service").describe("How much could break if it goes wrong."),
        context: z
          .string()
          .optional()
          .describe(`A diff or plan of the change, at most ${MAX_CONTEXT_BYTES} bytes, for the plane's optional AI review. Never part of what is signed.`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => toResult(await submitIntent(fw, args)),
  );

  server.registerTool(
    "wait_verdict",
    {
      title: "Wait for Floodwall's answer",
      description:
        "Wait for the plane's answer on an intent that was queued or held (a person may need to approve it). Returns the latest status " +
        "after at most `wait` seconds. Proceed with the change ONLY when it says proceed: true; if it is still held or queued when " +
        "the wait ends, STOP and tell the user it is waiting. Never make the change on a timeout.",
      inputSchema: {
        key: KEY,
        wait: z.number().min(0).max(120).default(30).describe("Seconds to wait, up to 120."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => toResult(await waitVerdict(fw, args)),
  );

  server.registerTool(
    "report_outcome",
    {
      title: "Report how an admitted change went",
      description:
        "After you make a change that submit_intent or wait_verdict admitted, report whether it succeeded or failed. This frees the " +
        "resource for the next change, so always call it, including when the change failed. Do not call it for a change that was not admitted.",
      inputSchema: {
        key: KEY,
        outcome: z.enum(["succeeded", "failed"]),
        reason: z.string().optional().describe("For a failure, what went wrong, in a sentence."),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => toResult(await reportOutcome(fw, args)),
  );

  server.registerTool(
    "list_held",
    {
      title: "List changes waiting for approval",
      description:
        "List the changes the plane is holding for a person to approve, with why and an AI-written summary when there is one. " +
        "Read-only. It needs an operator-scoped key; an agent key is refused. Use it to tell the user what is waiting, never to approve anything.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => toResult(await listHeld(fw)),
  );

  return server;
}

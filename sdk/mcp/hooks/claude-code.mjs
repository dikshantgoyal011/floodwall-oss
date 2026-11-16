#!/usr/bin/env node
// Claude Code hook: ask a Floodwall plane before risky shell commands.
//
// Register it for PreToolUse, PostToolUse and PostToolUseFailure on Bash (see
// README). PreToolUse exits 2 with the reason on stderr to block the command
// unless the plane admits it; the other two report how it went.
//
// This script fails closed: any crash, unreadable input or missing module
// exits 2 rather than letting an unchecked command through.

function blocked(why) {
  try {
    process.stderr.write(`Blocked by Floodwall: hook error (${why?.message ?? why})\n`);
  } finally {
    process.exit(2);
  }
}

process.on("uncaughtException", blocked);
process.on("unhandledRejection", blocked);

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  // Imported here so a missing dependency is caught like any other failure.
  const { handleHook } = await import("../src/hook.js");
  const result = await handleHook(input);
  if (result.block) {
    process.stderr.write(`${result.block}\n`);
    process.exit(2);
  }
} catch (error) {
  blocked(error);
}

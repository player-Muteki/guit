const { appendFileSync, copyFileSync, readFileSync } = require("node:fs");

const [mode, local, remote, merged] = process.argv.slice(2);
// A worktree file that was deleted has no counterpart on disk, so Git passes
// an empty `$REMOTE`. Reading it as a path fails on Windows (the empty string
// resolves against the device namespace) while working on Linux, where Git
// happens to hand over a real empty temporary file. The empty remote is the
// content being compared, not a missing file.
const read = (path) => (path ? readFileSync(path, "utf8") : "");
const record = {
  mode,
  local: read(local),
  remote: read(remote),
};
appendFileSync(process.env.GUIT_TOOL_RECORD, `${JSON.stringify(record)}\n`);
if (process.env.GUIT_TOOL_EXIT) process.exit(Number(process.env.GUIT_TOOL_EXIT));
if (mode === "merge") copyFileSync(remote, merged);

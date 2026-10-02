const { appendFileSync, copyFileSync, readFileSync } = require("node:fs");

const [mode, local, remote, merged] = process.argv.slice(2);
// A worktree file that was deleted has no counterpart on disk. Linux Git hands
// over `/dev/null`, which reads as empty content; Git for Windows hands over
// the literal `nul`, which opens as a path under the current directory and
// fails with ENOENT. Either way the empty remote *is* the content being
// compared, not a missing file.
const isNull = (path) =>
  !path || path === "/dev/null" || /(^|[\\/])nul$/i.test(path);
const read = (path) => (isNull(path) ? "" : readFileSync(path, "utf8"));
const record = {
  mode,
  local: read(local),
  remote: read(remote),
};
appendFileSync(process.env.GUIT_TOOL_RECORD, `${JSON.stringify(record)}\n`);
if (process.env.GUIT_TOOL_EXIT) process.exit(Number(process.env.GUIT_TOOL_EXIT));
if (mode === "merge") copyFileSync(remote, merged);

const { appendFileSync, copyFileSync, readFileSync } = require("node:fs");

const [mode, local, remote, merged] = process.argv.slice(2);
const record = {
  mode,
  local: readFileSync(local, "utf8"),
  remote: readFileSync(remote, "utf8"),
};
appendFileSync(process.env.GUIT_TOOL_RECORD, `${JSON.stringify(record)}\n`);
if (process.env.GUIT_TOOL_EXIT) process.exit(Number(process.env.GUIT_TOOL_EXIT));
if (mode === "merge") copyFileSync(remote, merged);

// M6-03 decision-6③ benchmark: how long does the frontend spend rebuilding
// the pure change-list view model (fileModel.buildRows) for a 10k-file
// snapshot? Run: node tools/bench/file-model-bench.mjs
// Threshold from the plan: p50 > 3 ms ⇒ memoize by file-set identity.

import { buildRows } from "../../app/src/fileModel.ts";

function files(count, dirtyFraction, untrackedFraction) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const untracked = i >= count * (1 - untrackedFraction);
    const dirty = !untracked && i % Math.round(1 / dirtyFraction) === 0;
    out.push({
      id: i,
      display: `nested/dir${i % 40}/file-${i}.c`,
      renameFrom: null,
      group: untracked ? "untracked" : dirty ? "worktree" : "staged",
      indexStatus: dirty ? "M" : untracked ? "?" : "A",
      worktreeStatus: dirty ? "M" : "",
      staged: dirty || untracked,
      unstaged: dirty,
      conflict: false,
      untracked,
      submodule: false,
    });
  }
  return out;
}

const snapshot = files(10000, 0.1, 0.0);
const collapsed = new Set();
const times = [];
for (let run = 0; run < 25; run += 1) {
  const started = performance.now();
  const rows = buildRows(snapshot, collapsed);
  times.push(performance.now() - started);
  if (rows.length !== snapshot.length + 2) {
    throw new Error(`unexpected row count ${rows.length}`);
  }
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
console.log(
  JSON.stringify({
    files: snapshot.length,
    iterations: times.length,
    medianMs: Number(median.toFixed(3)),
    minMs: Number(times[0].toFixed(3)),
    maxMs: Number(times[times.length - 1].toFixed(3)),
    thresholdMs: 3,
    memoize: median > 3,
  }),
);

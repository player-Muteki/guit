// Which part of a snapshot a component actually renders.
//
// One refresh costs the backend one Git capture, and the snapshot it publishes
// already carries what that capture found: the files, the current branch, the
// operation in progress. The panel used to answer every accepted snapshot by
// asking each module to read its own list back out of Git — six reads per
// refresh, three of them for pages that had left the window. A component now
// names the domain it renders and is asked only when that domain's own part of
// the snapshot moved, so a refresh that changes nothing on screen asks for
// nothing. A session that closes is the exception: it is not a read but a
// clearing, and every domain has to be told.
//
// What this does *not* claim matters as much as what it does. A snapshot
// reports the current head, its upstream counts and the operation in progress;
// it does not report a branch elsewhere in the repository that someone else
// moved. So the ref listing never promises to notice that on its own — the
// picker that shows the names reads them again the moment it opens.

import type { SnapshotView } from "./types";

export type SnapshotDomain = "graph" | "refs";

export const SNAPSHOT_DOMAINS: readonly SnapshotDomain[] = ["graph", "refs"];

export type DomainHandler = (snapshot: SnapshotView | null) => void;

// A character no repository path, ref name or object id can contain, so two
// different snapshots cannot collide by having their parts concatenated.
const FIELD_SEPARATOR = "\u0000";

// The graph is drawn from one branch's history, so it has to be read again only
// when the branch it is drawn from, or that branch's head, is a different one.
// The head's *state* is part of the answer as well: a bare repository, an unborn
// branch and a detached head are three different things to say about a history
// that has no commits in them.
const graphKey = (snapshot: SnapshotView): string =>
  [
    snapshot.repo.openPath,
    snapshot.branch?.name ?? "",
    snapshot.branch?.headState ?? "",
    snapshot.branch?.oid ?? "",
  ].join(FIELD_SEPARATOR);

// The ref listing shows every name in the repository, but a snapshot reports
// only the current head, its upstream counts and the operation in progress.
// Those are what a refresh can reveal here; the rest is the picker's problem,
// and it reads the names again on open.
const refsKey = (snapshot: SnapshotView): string => {
  const branch = snapshot.branch;
  return [
    snapshot.repo.openPath,
    branch?.name ?? "",
    branch?.headState ?? "",
    branch?.oid ?? "",
    branch?.upstream ?? "",
    branch?.ahead ?? "",
    branch?.behind ?? "",
    snapshot.operation?.kind ?? "",
  ].join(FIELD_SEPARATOR);
};

const DOMAIN_KEY: Record<SnapshotDomain, (snapshot: SnapshotView) => string> = {
  graph: graphKey,
  refs: refsKey,
};

const handlers = new Map<SnapshotDomain, Set<DomainHandler>>();
const remembered = new Map<SnapshotDomain, string>();

// Adding the same function twice is one subscription, not two: a component that
// is rebuilt while its old handler is still registered cannot quietly double
// every read it asks for.
export function subscribeToDomain(domain: SnapshotDomain, handler: DomainHandler): () => void {
  let set = handlers.get(domain);
  if (set === undefined) {
    set = new Set<DomainHandler>();
    handlers.set(domain, set);
  }
  const subscribers = set;
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}

// How many handlers are registered, in one domain or in all of them. The layout
// and read-budget probes use this the way a leak check uses a handle count:
// switching pages back and forth has to come back to the same number.
export function domainSubscriptions(domain?: SnapshotDomain): number {
  if (domain === undefined) {
    let total = 0;
    for (const set of handlers.values()) total += set.size;
    return total;
  }
  return handlers.get(domain)?.size ?? 0;
}

export function publishSnapshot(snapshot: SnapshotView | null): void {
  if (snapshot === null) {
    // The session ended. Every domain is told, because the answer is not a read
    // but a clearing: a graph full of commits from a repository that is no
    // longer open is a lie about the screen. And the remembered keys go with it
    // — the next repository must not inherit this one's idea of what has
    // already been seen.
    remembered.clear();
    for (const domain of SNAPSHOT_DOMAINS) {
      const subscribers = handlers.get(domain);
      if (subscribers === undefined) continue;
      for (const handler of [...subscribers]) handler(null);
    }
    return;
  }
  for (const domain of SNAPSHOT_DOMAINS) {
    const key = DOMAIN_KEY[domain](snapshot);
    if (remembered.get(domain) === key) continue;
    remembered.set(domain, key);
    const subscribers = handlers.get(domain);
    if (subscribers === undefined) continue;
    for (const handler of [...subscribers]) handler(snapshot);
  }
}

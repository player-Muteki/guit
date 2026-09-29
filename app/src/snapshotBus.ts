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
// The domains are counted by the backend rather than worked out here. It ships
// one number per domain per session, and only it can decide what counts as that
// domain having moved — which matters because nothing drawn from Git can tell
// two copies of one repository apart. The same numbers bind every asynchronous
// read the panel makes: a page of commits is asked *as* a domain's current
// context, and an answer that comes back under another one has left the screen
// it belongs to.

import type { ReadContext, SnapshotView } from "./types";

export type SnapshotDomain = "graph" | "refs";

export const SNAPSHOT_DOMAINS: readonly SnapshotDomain[] = ["graph", "refs"];

export type DomainHandler = (snapshot: SnapshotView | null) => void;

// The context a read of this domain has to be asked with.
export const readContextFor = (snapshot: SnapshotView, domain: SnapshotDomain): ReadContext => ({
  sessionId: snapshot.sessionId,
  generation: domain === "graph" ? snapshot.historyGeneration : snapshot.refsGeneration,
});

// A listing no domain owns: bound to the session alone, so a refresh leaves it
// valid and opening another repository does not.
export const sessionContext = (snapshot: SnapshotView): ReadContext => ({
  sessionId: snapshot.sessionId,
  generation: null,
});

// Whether an answer arrived from the session and generation the request was
// asked against. A mismatch is not a failure: the view has moved on, so the
// result is dropped and the next notification for that domain asks again.
export const contextMatches = (asked: ReadContext, answered: ReadContext): boolean =>
  asked.sessionId === answered.sessionId && asked.generation === answered.generation;

// A character no repository path, ref name or object id can contain, so two
// different snapshots cannot collide by having their parts concatenated.
const FIELD_SEPARATOR = "\u0000";

const domainKey = (snapshot: SnapshotView, domain: SnapshotDomain): string => {
  const context = readContextFor(snapshot, domain);
  return `${context.sessionId}${FIELD_SEPARATOR}${context.generation ?? ""}`;
};

const DOMAIN_KEY: Record<SnapshotDomain, (snapshot: SnapshotView) => string> = {
  graph: (snapshot) => domainKey(snapshot, "graph"),
  refs: (snapshot) => domainKey(snapshot, "refs"),
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

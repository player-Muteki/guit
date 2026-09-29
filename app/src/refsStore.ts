// One names read per references generation, however many views draw a name.
//
// The commit graph labels its rows and the branch picker lists them, and both
// are answered by the same read of the same namespace. Two views asking the same
// question in the same tick is the per-refresh read cost this panel spent a
// stage removing, arriving again in a smaller shape — so the read lives here,
// keyed by the context it was asked with, and a view asks for a context rather
// than for Git.
//
// What is cached is the answer to a bounded read: the backend echoes the session
// and generation it replied under, so a cached answer is checked against the
// screen that wants it exactly as a fresh one is. A refusal is not an answer
// worth keeping, so nothing is cached about a read that failed and the next ask
// runs it again.

import { invoke } from "@tauri-apps/api/core";
import type { ReadContext, RefListing, SessionRead } from "./types";

// A character no session id or generation can contain, so two contexts cannot
// collide by having their parts concatenated.
const slot = (context: ReadContext): string => `${context.sessionId}\u0000${context.generation ?? ""}`;

// The generation on screen and the one replacing it, and nothing older: a
// bigger cache would be a cache of repositories the panel left behind.
const KEEP = 2;

const answers = new Map<string, SessionRead<RefListing>>();
const inFlight = new Map<string, Promise<SessionRead<RefListing>>>();

export function readRefListing(asked: ReadContext): Promise<SessionRead<RefListing>> {
  const at = slot(asked);
  const settled = answers.get(at);
  if (settled !== undefined) return Promise.resolve(settled);
  const already = inFlight.get(at);
  if (already !== undefined) return already;
  const request = invoke<SessionRead<RefListing>>("list_refs", { context: asked })
    .then((read) => {
      inFlight.delete(at);
      answers.set(at, read);
      while (answers.size > KEEP) {
        const oldest = answers.keys().next();
        if (oldest.done === true) break;
        answers.delete(oldest.value);
      }
      return read;
    })
    .catch((error: unknown) => {
      inFlight.delete(at);
      throw error;
    });
  inFlight.set(at, request);
  return request;
}

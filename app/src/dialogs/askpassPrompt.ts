// Pure view-model for the credential prompt's wording, mirroring `fileModel.ts`
// so `node --test` can import it directly.
//
// A prompt has to name what it is asking about. Git may ask again while the
// dialog is still open — one request per remote, per credential type — and the
// text a user typed for one host must never travel to another. So a replaced
// prompt says so out loud, and the answer box is cleared rather than quietly
// re-aimed.

import type { AskPassRequest } from "../types";

// True when `next` is a different question than the one already on screen.
export const replacesPrompt = (
  previous: AskPassRequest | null,
  next: AskPassRequest,
): boolean =>
  previous !== null &&
  (previous.operationId !== next.operationId ||
    previous.target !== next.target ||
    previous.kind !== next.kind);

export function promptText(request: AskPassRequest, replaced: boolean): string {
  const question =
    request.kind === "password"
      ? request.user !== null
        ? `Password for ${request.target} as ${request.user}:`
        : `Password for ${request.target}:`
      : `Username for ${request.target}:`;
  return replaced
    ? `${question} (this prompt replaced another one; what you had typed was discarded)`
    : question;
}

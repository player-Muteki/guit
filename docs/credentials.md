# Credentials and authentication

**guit never stores credentials.** There is no guit-owned credential file,
keychain entry or in-memory cache that outlives a single operation.

## What guit respects

- Your `credential.helper` configuration is left alone: if Git can answer a
  login non-interactively (osxkeychain, GCM, libsecret, a store helper),
  operations proceed exactly as they would in a terminal. guit reads
  `credential.helper` only to *report* the current setup in its credential
  status panel — read-only, never modified.
- guit invokes your system `git` with your own configuration; it strips
  inherited `GIT_*` variables from its child processes so nothing about your
  environment leaks into an operation by accident.
- For SSH remotes, an existing **ssh-agent** is used automatically (Git's
  normal path). guit only reports whether `SSH_AUTH_SOCK` is present; it
  never reads the agent or your keys.

## Interactive HTTPS authentication (Linux/macOS)

When an operation hits an HTTP(S) remote that demands a login and no helper
answers, the operation fails as an authentication error and the UI offers a
one-time **"Retry with credentials"** action. Retrying attaches a temporary
askpass bridge to that single operation:

- Git is given `GIT_ASKPASS` pointing at guit itself, plus two guard
  variables, over a private unix socket in `$XDG_RUNTIME_DIR` (mode-0700
  directory, 0600 socket). The answer lives only in the process handoff —
  nothing is written to disk or logs.
- guit answers **only** `Username for 'http…'` / `Password for 'http…'`
  prompts. SSH passphrase prompts are refused with guidance to use
  ssh-agent, because passing a passphrase through a GUI prompt is exactly
  the pattern credential managers exist to avoid.
- The bridge lives at most as long as the operation; each unanswered prompt
  times out after 120 seconds and the operation fails honestly.
- The secret never appears in the UI, events, diagnostics or logs — the
  prompt text guit displays is validated (host must match the remote's
  redacted form) and prompts that try to smuggle a credential in their text
  are refused wholesale.

The bridge is **unix-only by design**: on Windows the retry path is refused
(`askpass_unsupported`) — use Git Credential Manager or another
`credential.helper`, which guit honors without touching.

## What guit will not do

- Save a password or token anywhere.
- Rewrite or install a `credential.helper` entry.
- Type into, or expose, your SSH private keys.
- Keep the askpass socket around after the operation ends.

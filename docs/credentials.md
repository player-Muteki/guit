# Credentials and authentication

**guit never stores credentials.** There is no guit-owned credential file,
keychain entry or in-memory cache.

It goes further than not storing them: guit performs no network operation, so
it never *needs* a credential. There is no password dialog, no "retry with
credentials" path and no askpass helper, and nothing in the product can be
given a secret to hold.

## Why there is nothing to prompt for

Every operation guit runs is a local one — status, staging, committing, branch
and tag management, history, conflict hand-off, reset preview. None of them
contacts a remote. `git fetch`, `pull`, `push`, `clone` and `ls-remote` are not
reachable from the window, and the process guit starts is told not to ask:

- `GIT_TERMINAL_PROMPT=0` is set on every `git` guit runs, so a repository with
  an unreachable or credential-protected remote stays a readable repository
  instead of turning into a prompt that hangs until the timeout.
- Inherited `GIT_*` variables are stripped from guit's child processes before
  that, so nothing about the environment leaks into an operation by accident.
- `submodule.recurse` is forced off and lazy fetching is disabled for the same
  reason: a repository that happens to have a partial clone must not have
  objects pulled down behind the panel's back.

Moving objects between the repository and a remote is Git's job in a terminal,
with whatever helper, agent or key you already configured. guit does not stand
in for that, and does not pretend to know the current state of a remote.

## What guit respects

- Your `credential.helper` configuration is left alone and never read. guit has
  nothing to authenticate, so it does not ask Git what would answer a prompt.
- Your remotes are left alone too. guit neither adds, rewrites nor removes one,
  and does not put their URLs in the diagnostics export.
- Your SSH keys and your agent are out of scope entirely: guit never reads
  `SSH_AUTH_SOCK`, never contacts an agent, and cannot type a passphrase into
  anything, because there is no dialog for it to type into.
- Remote-tracking refs such as `origin/main` are shown as the local metadata
  they are: the last state Git recorded for you, never claimed as live remote
  state.

## What guit will not do

- Save a password or token anywhere, in memory or on disk.
- Rewrite, install or read back a `credential.helper` entry.
- Read your SSH agent or your private keys.
- Ask you for a secret, or fetch an object, in order to render a view.

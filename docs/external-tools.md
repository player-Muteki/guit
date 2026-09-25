# External diff, merge and file tools

guit never shows file contents or diffs inside its own window. Every "open",
"diff" and "resolve conflict" action delegates to the operating system or to
the tools **you** configure in Git. guit only runs them through `git difftool`
/ `git mergetool` / the system opener, with argument arrays and the
repository as working directory — never through a shell.

## How guit picks the tool

guit adds no tool configuration of its own. Whatever your Git config says is
what runs, in Git's normal precedence (repository config beats global beats
system):

```gitconfig
[diff]
    tool = vimdiff            # or meld, kdiff3, ...
[difftool "meld"]
    trustExitCode = true      # see "Exit codes" below
[merge]
    tool = meld
[mergetool "meld"]
    path = /usr/bin/meld      # respect your own setup
```

`git difftool -y --no-prompt --trust-exit-code [--staged] -- <path>` is used
per file (with `--staged` for the staged column), and
`git mergetool -y --no-prompt -- <path>` for one conflicted file. A commit's
"Diff" runs your difftool against its first parent; for a root commit the
baseline is the repository's own empty tree object (established via
`git mktree`, so SHA-1 and SHA-256 repositories both work).

## Exit codes: what guit trusts

- **difftool** runs with `--trust-exit-code`, so a nonzero code from your
  tool is reported as a failed open, with the first stderr line preserved
  (redacted). Tools whose exit code is meaningless (many GUI diff tools)
  should be configured with `trustExitCode = false` (or unset) in Git —
  guit then judges success by Git's own exit status like any other caller.
- **mergetool** deliberately does **not** use `--trust-exit-code`: Git 2.53
  rejects that flag for mergetool, and mergetool's exit status reflects
  Git's re-check, not the merge tool. After mergetool closes, guit re-reads
  the **index**: if the file is still unmerged, the result is honestly
  reported as "still conflicted after the merge tool exited" — a closed tool
  is never presented as a resolved conflict. `git mergetool --tool-help`
  lists configured and built-in candidates.
- Cancelling while a tool runs reports `Cancelled`; guit then re-reads the
  repository state rather than assuming anything.

## Opening files

"Open file" hands the absolute path to the system opener — `xdg-open` on
Linux, `open` on macOS, `explorer.exe` on Windows — and does not wait for the
application. guit does not bundle or manage editor processes.

Note: only the Linux lane has been executed on a development machine;
the macOS and Windows openers are configured but not yet runtime-verified
(see `plan/M6-validation.md` platform matrix).

## Conflict resolution outside guit

Because conflicted files open in your own merge tool, the resolution flow is:
resolve and save in the tool → guit's watcher re-reads the index → the file
moves from conflicted to staged (or stays conflicted until you stage it).
Continue/abort of the underlying merge/rebase is offered from the operations
banner, never guessed.

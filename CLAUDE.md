# Working in this repo

## Commits

**One Conventional Commits subject line. Nothing else.**

```
<type>(<scope>): <description>
```

No body. No footers. No `Co-Authored-By:`, no `Generated with`, no trailers of
any kind. `git commit -m "…"` with a single `-m`, and never a heredoc or a
second `-m` that would open a body.

This is not a preference about tidiness — it is the same rule the factory
already enforces on itself. Every commit an ADW makes goes through
`git_helper.subjectLine`, which keeps the first non-empty line and throws the
rest away, so an agent that writes a body has written text nobody will read.
A commit made by hand or by an assistant working in this tree follows the rule
the machinery follows; otherwise `git log --oneline` tells the truth about half
the history and the shape of a commit depends on who happened to make it.

Pick the honest type — `feat`, `fix`, `refactor`, `docs`, `test`, `chore`. The
scope is the part of the tree that moved (`visualizer`, `git`, `tracer`,
`config`). `subjectLine` falls back to `chore:` when a type is missing, which is
a guess, not a target.

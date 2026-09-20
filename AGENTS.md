# Working in this repo

## Commits

**One Conventional Commits subject line. Nothing else.**

```
<type>(<scope>): <description>
```

No body. No footers. No `Co-Authored-By:`, no `Generated with`, no trailers of
any kind. `git commit -m "…"` with a single `-m`, and never a heredoc or a
second `-m` that would open a body.

Pick the honest type — `feat`, `fix`, `refactor`, `docs`, `test`, `chore`. The
scope is the part of the tree that moved (`visualizer`, `git`, `tracer`,
`config`). `subjectLine` falls back to `chore:` when a type is missing, which is
a guess, not a target.

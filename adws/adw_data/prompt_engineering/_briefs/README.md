# Team briefs

A brief is what every agent should know about one repo before it reads a line
of it: what the codebase is, the domain's own words, the conventions that are
not optional. It is inlined into every agent's system prompt as `{{repo_brief}}`
for any target whose `brief:` (default: the target's `name`) matches the file.

Two layers, first match wins, whole file:

1. `~/.sfo-build/briefs/<brief>.md` — **personal**. Yours alone, never
   committed. Private repos, side projects, a draft you are still checking.
2. `adws/adw_data/prompt_engineering/_briefs/<brief>.md` — **team**. This
   folder. For repos the team shares.

No file in either means no brief — never another repo's.

## Adding a team brief

Through a pull request, always. A brief reaches every agent on that repo and no
gate checks it: one wrong sentence misleads every run until someone notices.

- Name it for the repo, not your target: teammates register the same repo under
  their own names and point at it with `brief: <file>`.
- State only what you have checked in the code. A scout can draft one
  (`/sfo-build install` offers it); a person confirms it before it lands here.
- Keep it short and stable. Vocabulary, layout, conventions, how tests are
  written. The test **command** is not a brief's job — it comes from the
  target's registered `test:`.

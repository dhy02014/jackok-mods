# jackok-mods

A Claude Code plugin marketplace of [mods](https://code.claude.com/docs/en/plugins/mods/overview): plugins with a hooks module that change Claude Code's own interface. It has three mods: a session state band, a task pane, and handoff cards for work left to a later session.

| Plugin | What it adds |
| :-- | :-- |
| `state` | A band above the prompt with context trend, model and effort, cwd and git branch, 5-hour and 7-day rate limits, cost, tool and subagent tallies, advisor calls, and threshold toasts. `/state` hides or shows it. |
| `manage-pane` | Task tools (`task_create`, `task_update`, `task_list`) and a pane with the session's tasks, the subagents working them, and the loaded instruction files. `/pane` opens or closes it. |
| `handoff` | Handoff cards as local, uncommitted markdown notes in the repo, `card` and `list` tools, and a band of cards above the prompt. `/handoff` hides or shows it. |

## Requirements

The plugins need Claude Code v2.1.299 or later; the `manage-pane` pane uses text props that earlier releases do not draw. Check with `claude --version`.

Nothing else is required. git is optional: without it, `state` shows no git row and `handoff` uses the session directory. `handoff` runs git (`rev-parse`, `ls-files`, `status`, `check-ignore`) when it is available, and the OS `mkdir` and `mv` (cmd's built-ins on Windows), because the mods file API has no mkdir, rename or delete.

Where an organization manages Claude Code, some hooks do not run in a plugin a person installs: the compaction and model-switch toasts of `state`, and the cwd-change refresh of `handoff`.

## Install

```bash
claude plugin marketplace add dhy02014/jackok-mods
claude plugin install state@jackok-mods
claude plugin install manage-pane@jackok-mods
claude plugin install handoff@jackok-mods
```

Install only the plugins you want. Then run `/reload-plugins` in an open session, or start a new one.

The default install tracks `main`, which holds only checked releases but may need a newer Claude Code than you run. To match your version, pin the marketplace to a tag. The repo carries annotated tags named `cc-v<claude-code-version>`, each marking the release whose mods were checked live on that Claude Code version, and the tag message lists each plugin's version (`cc-v2.1.304`: manage-pane 2.0.0, handoff 1.1.6, state 1.0.1). Check your version with `claude --version`, then pin to the tag for it, or the newest tag not above it. A moving `stable` tag points at the latest checked release. Each plugin version also carries the standard `<plugin>--v<version>` tag (e.g. `manage-pane--v2.0.0`), which Claude Code's plugin dependency resolution reads. Adding `#ref` to the marketplace source pins a branch or tag ([docs](https://code.claude.com/docs/en/plugins/install#add-a-marketplace)).

```bash
claude plugin marketplace add dhy02014/jackok-mods#cc-v2.1.304
```

To update, run `claude plugin marketplace update jackok-mods`, then `claude plugin update <plugin>@jackok-mods`.

Options are set in the plugin's options in `/plugin`.

## state

A band above the prompt showing the session's state; `/state` hides or shows it.

The git part follows the main session's directory, even while a subagent works in a worktree. `git status` has a 10-second timeout and never holds up a turn end or a tool call.

Below 100 band columns the session id shows only its first 8 characters; pressing it still copies the full id. A long model id or branch name is cut off with `…` instead of wrapping the line.

| Option | Default | Effect |
| :-- | :-- | :-- |
| `per_model_limits` | off | Also shows per-model weekly limits, read every few minutes from the `https://api.anthropic.com/api/oauth/usage` endpoint with your Claude Code login. claude.ai subscriptions only. |

What it touches: with `per_model_limits` off, no network request is made and only the limits Claude Code reports are shown. With it on, the endpoint is undocumented and may change or stop working without notice. It makes no request when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. The cached per-model figures are kept separately for each `CLAUDE_CONFIG_DIR`, so sessions with different config directories never share them; a logout deletes that config directory's cached figures. `state` writes no files of its own; the cached figures live in the plugin store Claude Code keeps for it.

## manage-pane

Adds the tools `task_create`, `task_update` and `task_list` (Claude sees them as `mcp__manage-pane__task_*`), and a pane with two tabs. The Task tab lists the tasks with the subagents working them; agents tied to no task are listed under Other. The Prompt tab lists the instruction files loaded, each with the size of the body the context carried, and their total. `/pane` opens or closes the pane.

Tasks persist in the plugin's own store, which keeps the newest 50 sessions. A resumed session whose list was dropped starts again at #1. `/resume` and `/branch` empty the pane's task list at once. After `/resume`, the list comes back from the store on the next main-loop turn or task tool call. `/branch` starts with an empty list; the parent's list is not copied.

These behaviours are always on:

- An Agent whose description starts with `#N ` takes task N as its owner and sets it in progress. The built-in Agent tool's description is left untouched; the model learns the claim from the description of `task_create`: "An Agent description starting `#3 ` claims task 3." That wording is unchanged. The result of `task_create` also tells the model about the mark, in a context line on the main thread only (see the code-mode bullet below), because the tool description may stay unloaded while a tool result is always read. The claim is skipped when another running agent already owns task N; the agent is then drawn under task N without claiming it.
- An Agent call is never refused for its description. One without a `#N ` mark, or naming no open task, runs as typed and still claims nothing (no owner set, status unchanged). An Agent with no `#N ` mark at all is drawn under the sole in-progress task when exactly one task is in progress at spawn time; with none or two or more it goes under Other. An Agent whose `#N` names a missing or completed task goes under Other.
- Agents that neither claim a task nor are drawn under one (see above) are drawn in an "Other" section below the task list: running ones in full, finished ones as one dim line each, the newest 3. The section is absent when every agent is claimed or drawn under a task. A `/resume`, `/branch` or `/clear` empties it; agents from the previous session are not carried over.
- While any task is open, a subagent's hand-back gets a model-only note naming the open tasks it owns, followed by the open list; other background notifications get the open list alone. In auto mode, when a background subagent finishes by calling SubagentHandback, the report that reaches the main conversation carries the same hand-back note, for the reporting agent only (not other agents its report names), once per hand-back. A message a subagent sends mid-run, or a message from another session, carries none.
- `task_create` returns JSON text, `{"created":[{"id":"N","subject":"…"}]}`, with the tasks in input order; its description says so. The transcript still shows one `#N subject` line per task, also after a resume. `task_update` accepts a numeric `taskId` and numeric `addBlockedBy` items (3 is read as "3").
- Task calls fired at the same time (for example with `Promise.all` in a code-mode script) all take effect; none is lost.
- A `task_create`, `task_update` or `task_list` call that the engine timed out while it waited behind earlier task calls, or a queued call with 1 s or less of its time left when its turn comes, does nothing and returns "manage-pane: earlier task calls took too long, so this one did not run; the list is unchanged. Call it again."
- One stuck task call holds later task calls and `#N` claims for at most 10 s.
- In code mode, each task call inside a REPL script carries its own "Open tasks" reminder; the script's own result carries no extra summary. On the main thread (not a subagent), while any task is open, the `task_create` result adds a second context line after the Open tasks line: "An Agent description starting `#N ` (e.g. `#3 Review the diff`) lists that agent under task N." `task_update` and `task_list` carry no such line, and the `{"created":[...]}` shape is unchanged.
- A foreground Agent hand-back inside a script is noted on that Agent call's result.
- The Prompt tab's instruction-file list is recounted once after a burst of calls (a REPL call and its script's calls included), not once per call.
- In the pane, a subagent's REPL script shows no row of its own; the calls it makes do.

The description of `task_create` tells the model to use these tools instead of the built-in TaskCreate, TaskUpdate and TodoWrite, because only these show in the pane.

| Option | Default | Effect |
| :-- | :-- | :-- |
| `open_on_start` | on | Opens the pane when an interactive session starts. Off: the pane opens with the first task of a list, or with `/pane`. |

To turn manage-pane off, disable the plugin.

What it touches: the plugin's own task store; it never reads or writes the CLI tasks directory and runs no processes. It reads user agent definitions (for `isolation: worktree`) from `$CLAUDE_CONFIG_DIR/agents` when set, else `~/.claude/agents`, after the project's `<cwd>/.claude/agents`. It reads back, to size them, the instruction files (CLAUDE.md, rules) the conversation loaded.

Models that still ship the built-in task tools (Opus 4.7, Sonnet 4.6, Haiku 4.5 and earlier, per the [tools reference](https://code.claude.com/docs/en/tools-reference)) would see two task tool sets. To avoid that, leave the built-in task tools out of the list you pass to `--tools`.

## handoff

Cards are markdown files in `<repo>/handoff/`, and closed cards are in `<repo>/handoff/closed/`. Inside a git worktree, the repo is the main checkout; without git, it is the session directory. Outside git, `card` refuses to create a card when the session's folder is the home folder or a filesystem root.

Cards are local notes and are not committed by default. The mod never edits `.gitignore` or anything under `.git`. To keep cards out of `git status`, add these lines to `.gitignore` or `.git/info/exclude`: `/handoff/*.md` and `/handoff/closed/` (or simply `/handoff/`). Creating the first card in a repo's card folder runs `git check-ignore`; if the folder is not ignored, the tool result tells Claude to mention to the user that `/handoff/` can be added to `.gitignore` or `.git/info/exclude`, and not to edit either file unless asked. The note appears once per repo and never in a repo whose card folder already holds files.

The `card` tool creates or updates a card, and `status: done` closes it. Its description tells Claude to call it only when the user asks for a handoff or to save work for a later session. Creating or updating a card returns the card's absolute path, then a line `slug: <slug>` (when two open cards share a slug, as with cards written by hand or by other sessions, this line gives the file name without `.md`, `<date>-<slug>`, which names only the card just written), then the not-git-ignored note when it applies. Closing returns both absolute paths, the one it was moved from and the one in `handoff/closed/`; the doc line after it still uses `~` paths. The `slug` field is an existing card's slug, which updates or closes that card, or a new slug (a-z, 0-9, `-`), which names the card being created. Card calls made at the same time run one after another; if Claude Code times out a card call while it waits behind earlier card calls, the model gets "card: earlier card calls took too long, so this one did not run; no card changed. Call it again." A call whose work had already begun when it timed out still gets "handoff: the tool failed; no card changed." Titles that slug alike (every Hangul title becomes `handoff`) get separate files (`-handoff.md`, `-handoff-2.md`). The `list` tool lists cards. A band above the prompt shows the cards with each one's age and status and an all/open/hold filter; `/handoff` hides or shows it. On a session's first prompt, the model gets pointers to the cards.

Each card is one band row. `card` refuses a new `title` wider than 40 terminal cells or a `next` wider than 60, where a Hangul or CJK character counts 2. A card already on disk that is longer still loads, and the band cuts its text with `…` so the age and status stay visible.

| Option | Default | Effect |
| :-- | :-- | :-- |
| `hold_on_exit` | off | When the repo has uncommitted changes and no card was written or closed this session, the first `/clear` or `/exit` is held with a reminder; entering it again goes through. Every change under the repo's top-level `handoff/` folder is ignored, not just card files. |

Permissions: a deny permission rule (or a policy that denies the tool) for `mcp__handoff__card` is honoured, and no card is created, updated or closed. A `tool.check` hook for it refuses the same way, with no card written. If Claude Code cannot answer the permission check, nothing is refused. Card writes are not prompted, because a mod tool cannot open a permission dialog on this Claude Code version; a rule that would ask lets the write through. A `PreToolUse` hook from a user or project settings file, or from a plugin's `hooks.json`, does not run for `card` or `list`, because the mod answers its own tools; use a deny rule instead.

What it touches: closing moves the card into `handoff/closed/`, and moves its linked doc too, only when that doc is a git-tracked file in the repo that no open card still names. The closed card's `doc:` line is updated. If `handoff/closed/` is git-ignored, a moved doc shows as deleted in `git status` and its new copy is ignored, so the next commit removes it from the repo; the file itself stays on disk. Nothing is deleted or overwritten: name clashes get `-2`, `-3` and so on, and a failed move leaves the file in place. It runs `git rev-parse`, `git ls-files`, `git status`, `git check-ignore`, `mkdir` and `mv` (cmd's built-ins on Windows), and every git run uses `--no-optional-locks`. Each git run the tool makes (finding the workspace root, checking whether a doc is tracked) is capped at 5 s. If git fails only after that limit, card create, update and close are refused with "card: git did not answer within 5 s; no card written. Call it again." and nothing is written in the session's directory; `list` and the band still fall back to the session's directory. The card refresh after each turn runs in the background and never holds the turn. The home-folder refusal compares the path as given; a symlinked home is not resolved.

## Language

The plugins' own text (toasts, band and pane labels, command replies) is always English. Only content written for a person to read follows Claude Code's `language` setting: when it is set, the task tools ask the model to write task subjects and activeForm in that language, and the `card` tool asks for card text in it.

## Development

```bash
claude plugin validate .
claude plugin test <plugin>
```

Bump `version` in a plugin's `.claude-plugin/plugin.json` on every release. With an unchanged version, `claude plugin update` keeps users on the old copy.

## License

MIT. See [LICENSE](LICENSE).

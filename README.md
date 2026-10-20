# jackok-mods

A Claude Code plugin marketplace of [mods](https://code.claude.com/docs/en/plugins/mods/overview): plugins with a hooks module that change Claude Code's own interface. It has three mods: a session state band, a task pane, and handoff cards for work left to a later session.

| Plugin | What it adds |
| :-- | :-- |
| `state` | A band above the prompt with context trend, model and effort, cwd and git branch, 5-hour and 7-day rate limits, cost, tool and subagent tallies, advisor calls, and threshold toasts. `/state` hides or shows it. |
| `manage-pane` | Task tools (`task_create`, `task_update`, `task_list`) and a pane with the session's tasks, the subagents working them, and the loaded instruction files. `/pane` opens or closes it. |
| `handoff` | Handoff cards as markdown files in the repo, `card` and `list` tools, and a band of cards above the prompt. `/handoff` hides or shows it. |

## Requirements

The plugins need Claude Code v2.1.299 or later; the `manage-pane` pane uses text props that earlier releases do not draw. Check with `claude --version`.

Nothing else is required. git is optional: without it, `state` shows no git row and `handoff` uses the session directory. `handoff` also runs the OS `mkdir -p` and `mv -n`, and `manage-pane` runs the OS `mv -f` and `rm -f`, because the mods file API has no mkdir, rename or delete.

Where an organization manages Claude Code, some hooks do not run in a plugin a person installs: the compaction and model-switch toasts of `state`, and the cwd-change refresh of `handoff`.

## Install

```bash
claude plugin marketplace add dhy02014/jackok-mods
claude plugin install state@jackok-mods
claude plugin install manage-pane@jackok-mods
claude plugin install handoff@jackok-mods
```

Install only the plugins you want. Then run `/reload-plugins` in an open session, or start a new one.

The default install tracks `main`, which holds only checked releases but may need a newer Claude Code than you run. To match your version, pin the marketplace to a tag. The repo carries annotated tags named `cc-v<claude-code-version>`, each marking the release whose mods were checked live on that Claude Code version, and the tag message lists each plugin's version (`cc-v2.1.304`: manage-pane 2.0.0, handoff 1.1.6, state 1.0.1). Check your version with `claude --version`, then pin to the tag for it, or the newest tag not above it. A moving `stable` tag points at the latest checked release. Adding `#ref` to the marketplace source pins a branch or tag ([docs](https://code.claude.com/docs/en/plugins/install#add-a-marketplace)).

```bash
claude plugin marketplace add dhy02014/jackok-mods#cc-v2.1.304
```

To update, run `claude plugin marketplace update jackok-mods`, then `claude plugin update <plugin>@jackok-mods`.

Options are set in the plugin's options in `/plugin`.

## state

A band above the prompt showing the session's state; `/state` hides or shows it.

| Option | Default | Effect |
| :-- | :-- | :-- |
| `per_model_limits` | off | Also shows per-model weekly limits, read every few minutes from the `https://api.anthropic.com/api/oauth/usage` endpoint with your Claude Code login. claude.ai subscriptions only. |

What it touches: with `per_model_limits` off, no network request is made and only the limits Claude Code reports are shown. With it on, the endpoint is undocumented and may change or stop working without notice. It makes no request when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. `state` writes no files.

## manage-pane

Adds the tools `task_create`, `task_update` and `task_list` (Claude sees them as `mcp__manage-pane__task_*`), and a pane with two tabs. The Task tab lists the tasks with the subagents working them; agents claiming no task are listed under Other. The Prompt tab lists the instruction files loaded, each with the size of the body the context carried, and their total. `/pane` opens or closes the pane.

Tasks persist in the plugin's own store, which keeps the newest 50 sessions. `/resume` and `/branch` empty the pane's task list at once. After `/resume`, the list comes back from the store on the next main-loop turn or task tool call. `/branch` starts with an empty list; the parent's list is not copied.

These behaviours are always on:

- An Agent whose description starts with `#N ` takes task N as its owner and sets it in progress. The built-in Agent tool's description carries a one-sentence hint teaching the `#N ` mark, so no CLAUDE.md instruction is needed. The claim is skipped when another running agent already owns task N; the agent is then drawn under task N without claiming it.
- An Agent call is never refused for its description. One without a `#N ` mark, or naming no open task, runs as typed and claims nothing.
- Agents that claim no task are drawn in an "Other" section below the task list: running ones in full, finished ones as one dim line each, the newest 3. The section is absent when every agent is claimed. A `/resume`, `/branch` or `/clear` empties it; agents from the previous session are not carried over.
- While any task is open, a subagent's hand-back gets a model-only note naming the open tasks it owns, followed by the open list; other background notifications get the open list alone.
- Each task is also written to `~/.claude/tasks/<session>/<id>.json` in Claude Code's task-file format, honouring `CLAUDE_CODE_TASK_LIST_ID`.

The one option is `open_on_start` (default on): it opens the pane when an interactive session starts. Off: the pane opens with the first task of a list, or with `/pane`. To turn manage-pane off, disable the plugin.

What it touches: the plugin's own task store and `~/.claude/tasks/`.

Models that still ship the built-in task tools (Opus 4.7, Sonnet 4.6, Haiku 4.5 and earlier, per the [tools reference](https://code.claude.com/docs/en/tools-reference)) would see two task tool sets. To avoid that, leave the built-in task tools out of the list you pass to `--tools`.

## handoff

Cards are markdown files in `<repo>/handoff/`, and closed cards are in `<repo>/handoff/closed/`. Inside a git worktree, the repo is the main checkout; without git, it is the session directory.

The `card` tool creates or updates a card, and `status: done` closes it. The `list` tool lists cards. A band above the prompt shows the cards with each one's age and status and an all/open/hold filter; `/handoff` hides or shows it. On a session's first prompt, the model gets pointers to the cards.

Each card is one band row. `card` refuses a new `title` wider than 40 terminal cells or a `next` wider than 60, where a Hangul or CJK character counts 2. A card already on disk that is longer still loads, and the band cuts its text with `…` so the age and status stay visible.

| Option | Default | Effect |
| :-- | :-- | :-- |
| `hold_on_exit` | off | When the repo has uncommitted changes and no card was written or closed this session, the first `/clear` or `/exit` is held with a reminder; entering it again goes through. |

What it touches: closing moves the card into `handoff/closed/`, and moves its linked doc too, only when that doc is a git-tracked file in the repo that no open card still names. The closed card's `doc:` line is updated. Nothing is deleted or overwritten: name clashes get `-2`, `-3` and so on, and a failed move leaves the file in place. `handoff` never edits `.gitignore`. To keep closed cards untracked, add `handoff/closed/` to `.gitignore` yourself; moved docs then leave the index.

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

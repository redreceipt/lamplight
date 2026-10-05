# lamplight

**Issues in. Pull requests out.**

A small, sequential GitHub Issues runner for [pi](https://pi.dev), inspired by
[OpenAI Symphony](https://github.com/openai/symphony). Each issue gets an isolated
clone. Pi implements the change, validates it, and opens a draft PR. Just run
`npx lamplight`: it triages issues, maintains lamplight PRs, works the queue, and
runs QA when idle. No feature flags required.

No setup commit. No required workflow file. No runtime npm dependencies.

## Quick start

Requires **macOS or Linux**, **Node.js 22.19+**, `git`, authenticated
[GitHub CLI](https://cli.github.com), and a current `pi` with model credentials.

```sh
# Install pi if needed, then configure a provider and default model:
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi  # /login, then /model

gh auth login
gh auth setup-git

cd /path/to/your/repo
npx lamplight
```

This starts the full loop immediately and can change GitHub labels, comments,
issues, and PRs. Use `npx lamplight --dry-run` to preview one pass without writes,
or `npx lamplight --help` for usage. Ctrl-C stops the loop.

For repeatable runs, pin a version: `npx lamplight@0.3.0`. Nothing is added to the
target repo's package manifest.

To run directly from GitHub, use
`npx --allow-git=root github:redreceipt/lamplight --help`. The per-command
`--allow-git=root` opt-in is required by npm 12; omit it on older npm versions.
It does not change global npm settings. Lamplight has no Git dependencies.

## Commands

| Command | Behavior |
| --- | --- |
| *(no command)* | Triage, maintain open lamplight PRs, work one queued issue or run idle QA, sleep, repeat. |
| `run 72 81` | Process each explicit issue once, in order, then exit. No triage or idle QA. |
| `watch` | Optional alias for the default loop; not required. |
| `doctor` | Check executables, GitHub auth/access, repo, and storage locations. With `--model`, also check that model's auth. |
| `--help` | Full usage, examples, defaults, prerequisites, and safety notes. No credentials required. |
| `--version` | Print the package version. |

```sh
npx lamplight --label bug
npx lamplight --repo owner/repo --interval 600
npx lamplight run 72 81 --model 'anthropic/*sonnet*'
npx lamplight --dry-run
npx lamplight run 72 --workflow ~/.config/lamplight/my-workflow.md
```

### Options

| Option | Default / purpose |
| --- | --- |
| `--repo owner/repo` | Detected by `gh` from the current directory. With this option, no local checkout is needed. Uses `gh`'s configured host (`GH_HOST` for Enterprise). |
| `-m, --model pattern` | Pi's configured model; passed directly to pi when provided. |
| `--label name` | Filter the loop's work queue. Repeat for AND matching. Explicit `run` issues cannot be combined with label filters. |
| `--interval seconds` | 300; delay after **every** loop pass, including successful work. |
| `--agent-timeout seconds` | 1800 (30 minutes); hard deadline for each pi run, including tool execution. Timeout stops the runner and preserves recovery work. |
| `--workflow file` | Replace the bundled implementation/PR prompt with your own external Markdown file. Not interpreted as YAML or a template. |
| `--workspace-root dir` | Use persistent external workspaces instead of a fresh OS temp directory. Host/owner/repo namespaces are appended. Must be outside the current checkout. |
| `--dry-run` | Read GitHub and print one pass's plan. Never invokes pi, clones, locks, or writes runner state. A triage plan cannot predict which labels pi would change. |
| `--verbose` | Stream agent and command output instead of showing the terminal dashboard. |

Each loop automatically triages **all open issues**, even with `--label`: it
maintains `bug`/`blocked` labels and comments when blocked status changes. After
PR maintenance, it works one eligible issue. If the selected work queue is empty,
it runs QA and can file reproducible bugs after checking for duplicates. Then it
waits five minutes and repeats. Triage and idle QA are built in; there are no
`--triage` or `--qa` flags.

`run` and the default loop both skip closed/blocked issues and issues already referenced by
an open PR. Reference detection uses GitHub's closing-issue links and conservative
body/title references (`#72` or the full issue URL). A mention can cause a skip;
review the referenced PR if an issue appears incorrectly in flight.

The loop orders bugs first, then oldest-first, after filtering blocked issues.
It maintains same-repository branches named `lamplight/GH-<number>-<slug>`, not arbitrary
PRs, fork branches, or existing `symphony/` branches. PR checkout/fetch failures
stop before pi runs. Each list is capped at 1,000 results and reaching that cap
stops the runner rather than silently missing work.

The bundled workflow requests focused changes, repo-specific checks, real runtime
proof under `## Proof`, draft PRs, and no automatic merge or review request.
QA findings must show the problem visually when applicable, alongside the explanation;
PRs must visually demonstrate the solution when possible, with before/after evidence
for visible bug fixes. Attach or embed real-runtime screenshots or interaction videos
in the issue/report or PR, redact sensitive data, and keep artifacts outside Git.
Explain when visuals are not applicable and provide other runtime evidence; if
applicable visuals cannot be captured or attached, report the blocker and keep PRs
draft. These evidence rules also apply to custom workflows.
Pi reads existing `AGENTS.md`/`CLAUDE.md`; no lamplight-specific file is required.
Repo-local pi settings/extensions are not automatically trusted (`--no-approve`).
Global pi configuration still applies. A custom workflow replaces implementation
instructions, not the runner's top-level safety instructions or triage/QA tasks.

## Where everything lives

```text
<OS temp directory>/lamplight-<random>/
  GH-72/       # implementation checkout
  PR-99/       # separate PR-maintenance checkout
  queue/       # triage checkout
  QA/          # idle-QA checkout (created when the queue is empty)

<OS temp directory>/lamplight-<uid>-<repo-hash>.lock/
  pid          # one active runner per user/repo in this temp directory

~/.pi/agent/sessions/
  ...          # pi's default transcript storage, grouped by workspace path

${XDG_STATE_HOME:-~/.local/state}/lamplight/github.com/owner/repo/
  logs/        # private per-run output logs (agent text and command diagnostics)
```

Each run creates a private, unique workspace directory using Node's `os.tmpdir()`
and `fs.mkdtemp()` (respecting the OS temp configuration, such as `TMPDIR`).
Successful runs delete that directory. Errors and Ctrl-C/SIGTERM retain it and
print its path for recovery; OS cleanup may eventually remove temp directories.
Pi manages session storage itself; its environment/settings overrides still apply.
Lamplight does not pass `--session-dir`; only run logs use its persistent storage.
Sessions normally survive workspace cleanup and are grouped by each temporary
checkout's path. Dry-run and doctor never create workspaces, locks, or logs. There is no
workspace reuse between runs by default.

Use `--workspace-root` for persistent, reusable clones; these are never automatically
deleted. Existing clones and transcripts under the old
`${XDG_STATE_HOME:-~/.local/state}/lamplight/` location are untouched; pass that
storage base as `--workspace-root` to reuse clones. Stop old runners before upgrading:
old and new versions use different lock locations. Preserve wanted transcripts and
unfinished clone work before removing that old Lamplight directory, not all of `~/.local`.

Lamplight doesn't install itself into your project, edit `.gitignore`, or create a
`WORKFLOW.md`. The caller's checkout is not used for implementation. Unsaved local
changes are not copied into the workspace; work starts from the remote repository.
Paths and transcripts can contain private source code or issue data; do not publish
them indiscriminately.

Ctrl-C/SIGTERM and agent timeouts stop the active child's process tree, including
pi's detached tool shells, before releasing the runner lock. Processes get one
second to exit before SIGKILL. Process-tree inspection requires the standard `ps`
command on macOS/Linux. The printed
`Lock:` path is deterministic for the OS user and GitHub host/owner/repo, independent
of workspace location. After a crash or SIGKILL, inspect its `pid` file and confirm
no runner/agent is active before removing that stale lock. Don't remove active locks
or run concurrent instances with different OS temp directories for the same repo.
Errors exit nonzero rather than continuing on the wrong branch.
Agent text and command diagnostics are saved in private run logs; pi sessions are
retained externally. Logs are not automatically pruned.

### Live session progress

Interactive terminals show a fixed, non-scrolling dashboard: repository, elapsed
time, current phase and issue/PR title, finished agent runs, skipped explicit-run
issues, and the previous completion or skip. Between passes it counts down to the
next pass. Agent text and git output go to a durable run log, not the dashboard.

The dashboard uses the terminal's alternate screen, fits its width and height,
and restores the screen and cursor on exit, including errors and Ctrl-C. Exit
prints a summary and the run-log path, plus a recovery path when temporary
workspaces are retained. Failures remain visible after the dashboard closes.
Counts span the current invocation, not prior sessions; “finished” means the
agent returned successfully, **not** that a PR was created or an issue resolved.

Use `--verbose` for streaming output. Redirecting either output stream, setting
`TERM=dumb`, running `doctor`, or using `--dry-run` also keeps output plain, with
no cursor controls. Dry runs never count as finished agent work or write logs.
No terminal UI dependencies are needed.

## Safety and scope

- **This is an autonomous coding agent, not a sandbox.** Clones separate working
  trees; pi can still access anything its OS account and credentials can access.
  Issues, repository instructions, and review comments can contain prompt injection.
  Use a dedicated account/container/VM and narrowly scoped credentials for untrusted
  repos or unattended work. See [pi's security guidance](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md).
- Starting lamplight authorizes model usage, local code execution, commits, pushes,
  issue labeling/comments/creation, and draft PR creation/maintenance. It can incur
  model costs. `run` limits work to explicit issues without triage/QA. Prompts
  prohibit merges/deploys, but prompts are not permission enforcement. Restrict
  credentials and use branch protection for hard controls.
- Triage, PR maintenance, and issue-generating idle QA are automatic in the loop.
  Every lamplight PR is inspected each pass; increase `--interval` to reduce cost.
- Doctor without `--model` does not validate provider credentials, and dry-run
  does not verify model readiness. Run `pi` to configure `/login` and `/model`.
- GitHub + pi only. No daemon, parallel agents, tracker adapters, automatic
  deployments, or automatic merges. Keep the loop understandable.

## Development and publishing

```sh
npm test
npm pack --dry-run
node bin/lamplight.js --help
```

No install/build step is required for development. Tests use Node's built-in test
runner, real temporary Git repositories, and local gh/pi doubles; they do not make
GitHub changes or spend model tokens. CI tests Linux/macOS on Node 22.19 and 24,
including launching the packed executable through npm.

### Automated releases

Use [Conventional Commits](https://www.conventionalcommits.org/) for commits merged
into `main` (including squash-merge titles):

- `fix: ...` releases a patch.
- `feat: ...` releases a minor.
- `feat!: ...`, `fix!: ...`, or a `BREAKING CHANGE:` footer releases a major.
- `docs:`, `chore:`, and `test:` do not release on their own.

Every push to `main` runs the full CI matrix. After it passes,
[semantic-release](https://github.com/semantic-release/semantic-release) calculates
the version from commits since the last `v*` release tag, updates the package in
CI, publishes to npm, and creates a GitHub Release with generated notes and the
package tarball. Git tags—not the source `package.json` version—track releases;
there are no version-bump commits or manual publishing steps.

The npm package's trusted publisher must authorize `redreceipt/lamplight` and
`release.yml`. Publishing uses GitHub's OIDC identity, with automatic provenance;
no npm token or per-release OTP is required. Only the publish job has write
permissions. Release runs are serialized and cannot cancel an active publish.

The **Release** workflow can also be dispatched on `main` to retry failures before
tag creation. If a publish fails after creating its tag, inspect npm and GitHub
state before recovery; rerunning alone does not republish that version.
Capture real CLI runtime proof before merging behavior changes; CI and generated
release notes do not substitute for that proof.

## Origin

Lamplight grew out of a small Bash script for running GitHub issues through pi.
Its orchestration idea is inspired by **[OpenAI Symphony](https://github.com/openai/symphony)**:
turn issue-tracker work into isolated agent runs.

This is an independent implementation, not an official OpenAI project or a full
implementation of Symphony's specification. No upstream Symphony source files
are bundled. OpenAI Symphony is Apache-2.0 licensed; lamplight is [MIT licensed](LICENSE).

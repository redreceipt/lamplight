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

For repeatable runs, pin a version: `npx lamplight@0.2.0`. Nothing is added to the
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
| `doctor` | Check executables, GitHub auth/access, repo, and state path. With `--model`, also check that model's auth. |
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
| `--workflow file` | Replace the bundled implementation/PR prompt with your own external Markdown file. Not interpreted as YAML or a template. |
| `--workspace-root dir` | Override the external storage base. Host/owner/repo namespaces are still appended. Must be outside the current checkout. |
| `--dry-run` | Read GitHub and print one pass's plan. Never invokes pi, clones, locks, or writes runner state. A triage plan cannot predict which labels pi would change. |

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
Pi reads existing `AGENTS.md`/`CLAUDE.md`; no lamplight-specific file is required.
Repo-local pi settings/extensions are not automatically trusted (`--no-approve`).
Global pi configuration still applies. A custom workflow replaces implementation
instructions, not the runner's top-level safety instructions or triage/QA tasks.

## Where everything lives

```text
${XDG_STATE_HOME:-~/.local/state}/lamplight/
  github.com/owner/repo/
    GH-72/       # implementation checkout
    PR-99/       # separate PR-maintenance checkout
    queue/       # triage checkout
    QA/          # idle-QA checkout (created when the queue is empty)
    sessions/    # pi transcripts, outside every checkout
    .lock/pid    # one active runner per repo/storage root
```

Lamplight doesn't install itself into your project, edit `.gitignore`, or create a
`WORKFLOW.md`. The caller's checkout is not used for implementation. Unsaved local
changes are not copied into the workspace; work starts from the remote repository.
Workspaces persist for recovery; **there is no automatic deletion** of old clones.
Inspect and remove them yourself when no runner is active. Paths and transcripts
can contain private source code or issue data; do not publish them indiscriminately.

Ctrl-C/SIGTERM stops the active child and releases the runner lock. After a crash
or SIGKILL, inspect `.lock/pid` and confirm no runner/agent is active before removing
that stale lock. Don't run concurrent instances with different storage roots for
the same repo. Errors exit nonzero rather than continuing on the wrong branch.
Agent text streams to the terminal and pi sessions are retained externally.

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

Maintainer release:

```sh
npm login
npm publish --access public
```

Bump the package version before subsequent releases. Publish only after tests
and a real CLI smoke run, and inspect `npm pack --dry-run` to ensure no private
files ship.

## Origin

Lamplight grew out of a small Bash script for running GitHub issues through pi.
Its orchestration idea is inspired by **[OpenAI Symphony](https://github.com/openai/symphony)**:
turn issue-tracker work into isolated agent runs.

This is an independent implementation, not an official OpenAI project or a full
implementation of Symphony's specification. No upstream Symphony source files
are bundled. OpenAI Symphony is Apache-2.0 licensed; lamplight is [MIT licensed](LICENSE).

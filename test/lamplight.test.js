import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { options, actionable, linkedPR } from '../bin/lamplight.js';

const cli = resolve('bin/lamplight.js');
const repoURL = 'https://github.com/example/project';
const issue = (number, labels = [], state = 'OPEN') => ({ number, title: `Issue ${number}`, body: 'Fix it.', labels: labels.map(name => ({ name })), state, createdAt: `2026-01-${String(number).padStart(2, '0')}` });
const pr = (body, extra = {}) => ({ number: 99, title: 'A fix', body, headRefName: 'lamplight/GH-1-fix', isCrossRepository: false, closingIssuesReferences: [], ...extra });

test('CLI parsing rejects bad input and keeps explicit issues independent of watch filters', () => {
  assert.equal(options([]).command, 'watch');
  assert.deepEqual(options([]), options(['watch']));
  assert.equal(options(['--dry-run']).command, 'watch');
  assert.equal(options(['--help']).help, true);
  assert.equal(options(['--version']).version, true);
  assert.equal(options(['--verbose']).verbose, true);
  assert.equal(options([])['agent-timeout'], '1800');
  assert.equal(options(['--agent-timeout', '60'])['agent-timeout'], '60');
  for (const value of ['0', '-1', 'NaN', '1.5', '2147484']) assert.throws(() => options(['--agent-timeout', value]));
  for (const args of [['--triage'], ['--qa'], ['--interval', '0'], ['--repo', '../x']]) assert.throws(() => options(args));
  assert.deepEqual(options(['run', '2', '1', '2', '--model', 'anthropic/*sonnet*']).issues, [2, 1]);
  assert.deepEqual(options(['watch', '--label', 'bug', '--label', 'ready']).label, ['bug', 'ready']);
  for (const args of [['run'], ['run', '0'], ['run', '1;echo bad'], ['run', '9007199254740992'], ['run', '1', '--label', 'bug'], ['watch', '1'], ['watch', '--interval', '0'], ['watch', '--interval', 'NaN'], ['watch', '--interval', '2147484'], ['watch', '--repo', '../x'], ['run', '1', '-m'], ['wat'], ['watch', '--unknown'], ['run', '1', '--model=']]) {
    assert.throws(() => options(args), undefined, args.join(' '));
  }
});

test('queue is bugs-first, oldest-first, and excludes blocked/closed issues', () => {
  assert.deepEqual(actionable([issue(3), issue(2, ['BUG']), issue(1), issue(4, ['bug', 'BLOCKED']), issue(5, [], 'CLOSED')]).map(i => i.number), [2, 1, 3]);
});

test('PR links respect repository and issue-number boundaries', () => {
  assert.ok(linkedPR([pr('Closes #12')], 12, repoURL));
  assert.ok(linkedPR([pr(`Fixes ${repoURL}/issues/12`)], 12, repoURL));
  assert.ok(linkedPR([pr('', { closingIssuesReferences: [{ url: `${repoURL}/issues/12` }] })], 12, repoURL));
  for (const body of ['Closes #123', 'other/project#12', 'https://github.com/other/project/issues/12', `Fixes ${repoURL}/issues/123`]) {
    assert.equal(linkedPR([pr(body)], 12, repoURL), undefined, body);
  }
});

test('real CLI: zero-setup dry run, pi-managed sessions and temporary workspace/lock lifecycle', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lamplight-test-')));
  try {
    const bin = join(dir, 'bin');
    const checkout = join(dir, 'checkout');
    const state = join(dir, 'state');
    const log = join(dir, 'pi.jsonl');
    mkdirSync(bin);
    mkdirSync(checkout);
    const git = (...args) => execFileSync('git', args, { cwd: checkout, stdio: 'pipe' });
    git('init', '-b', 'trunk');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    writeFileSync(join(checkout, 'README.md'), 'Fixture\n');
    git('add', '.');
    git('commit', '-m', 'fixture');
    const temp = join(dir, 'temp');
    mkdirSync(temp);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temp, XDG_STATE_HOME: state, LAMPLIGHT_TEST_LOG: log, LAMPLIGHT_TEST_REPO: checkout };
    function script(name, text) {
      writeFileSync(join(bin, name), `#!${process.execPath}\n${text}`, { mode: 0o755 });
    }
    script('gh', `
      const { execFileSync } = require('node:child_process');
      const a = process.argv.slice(2);
      let result;
      const url = process.env.LAMPLIGHT_TEST_URL || '${repoURL}';
      if (a[0] === 'repo' && a[1] === 'view') result = {nameWithOwner:'example/project',url,defaultBranchRef:{name:'trunk'}};
      else if (a[0] === 'issue' && a[1] === 'view') result = {number:Number(a[2]),title:'Issue '+a[2],body:'Fix it.',state:'OPEN',labels:[],createdAt:'2026-01-01'};
      else if (a[0] === 'issue' && a[1] === 'list') result = JSON.parse(process.env.LAMPLIGHT_TEST_ISSUES || '${JSON.stringify([issue(1)])}');
      else if (a[0] === 'pr' && a[1] === 'list') result = JSON.parse(process.env.LAMPLIGHT_TEST_PRS || '[]');
      else if (a[0] === 'auth' && a[1] === 'status') process.exit(0);
      else if (a[0] === 'pr' && a[1] === 'checkout') process.exit(7);
      else if (a[0] === 'repo' && a[1] === 'clone') {
        execFileSync('git', ['clone', process.env.LAMPLIGHT_TEST_REPO, a[3]]);
        execFileSync('git', ['remote','set-url','origin',url], {cwd:a[3]});
      } else throw Error('Unexpected gh call: '+a.join(' '));
      if (result !== undefined) console.log(JSON.stringify(result));
    `);
    script('pi', `
      const { appendFileSync, writeFileSync } = require('node:fs');
      const { spawn } = require('node:child_process');
      function hang() {
        appendFileSync(process.env.LAMPLIGHT_TEST_HANG, process.pid+'\\n');
        if (process.argv[2]?.startsWith('--hung-') || process.env.LAMPLIGHT_TEST_IGNORE_SIGNALS) {
          process.on('SIGINT', () => {});
          process.on('SIGTERM', () => {});
        }
        if (process.argv[2] === '--hung-grandchild') console.log('Descendants ready');
        else spawn(process.execPath, [__filename, process.argv[2] === '--hung-tool' ? '--hung-grandchild' : '--hung-tool'], {detached:true,stdio:'inherit'});
        setInterval(() => {}, 1000);
      }
      if (process.argv[2]?.startsWith('--hung-')) hang();
      else if (process.argv[2] === '--version') console.log('test');
      else {
        appendFileSync(process.env.LAMPLIGHT_TEST_LOG, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+'\\n');
        console.log('Agent output sentinel');
        console.error('Agent diagnostic sentinel');
        const planFile = process.argv.at(-1).match(/^Plan file: (.+)$/m)?.[1];
        if (planFile) {
          const issues = JSON.parse(process.env.LAMPLIGHT_TEST_ISSUES || '${JSON.stringify([issue(1)])}');
          const prs = JSON.parse(process.env.LAMPLIGHT_TEST_PRS || '[]');
          const plan = {issue:issues[0]?.number ?? null,prs:prs.map(p => p.number),qa:!issues.length && !prs.length,reason:'Fixture decision'};
          writeFileSync(planFile, process.env.LAMPLIGHT_TEST_PLAN || JSON.stringify(plan));
        }
        if (process.env.LAMPLIGHT_TEST_HANG) hang();
        else process.exit(Number(process.env.LAMPLIGHT_TEST_PI_EXIT || 0));
      }
    `);
    const run = (args, extra = {}, entry = cli) => spawnSync(process.execPath, [entry, ...args], { cwd: checkout, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 });
    const stateRoot = join(state, 'lamplight', 'github.com', 'example', 'project');
    const workspacePath = output => output.match(/^Workspaces: (.+)$/m)[1];
    const lockPath = output => output.match(/^Lock: (.+)$/m)[1];
    const before = git('status', '--porcelain').toString();
    symlinkSync(cli, join(bin, 'lamplight'));
    let result = run(['--help'], {}, join(bin, 'lamplight'));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Inspired by OpenAI Symphony/);
    assert.doesNotMatch(result.stdout, /--triage|--qa/);
    result = run(['--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(log), false);
    result = run(['doctor']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(workspacePath(result.stdout)), false);
    const repoLock = lockPath(result.stdout);
    assert.equal(repoLock.startsWith(join(temp, `lamplight-${process.getuid()}-`)), true);
    assert.equal(existsSync(repoLock), false);
    assert.equal(existsSync(state), false);
    result = run(['run', '1', '2', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Would run #1/);
    assert.match(result.stdout, /Would run #2/);
    assert.match(result.stdout, /Session plan complete .*0 agent runs finished/);
    assert.doesNotMatch(result.stdout + result.stderr, /\x1b/);
    result = run(['run', '1', '--dry-run'], { LAMPLIGHT_TEST_PRS: JSON.stringify([pr('Closes #1')]) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0 agent runs finished, 1 skipped/);
    assert.equal(existsSync(state), false);
    assert.equal(existsSync(log), false);
    assert.equal(existsSync(workspacePath(result.stdout)), false);
    result = run(['--dry-run'], { LAMPLIGHT_TEST_PRS: JSON.stringify([pr('Closes #1')]) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Would triage/);
    assert.match(result.stdout, /Would maintain PR #99/);
    assert.match(result.stdout, /Would run idle QA/);
    assert.equal(existsSync(repoLock), false);
    assert.equal(existsSync(state), false);
    assert.equal(existsSync(log), false);
    result = run(['run', '1', '--workspace-root', join(checkout, 'state')]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside the current checkout/);
    symlinkSync(checkout, join(dir, 'alias'));
    result = run(['run', '1', '--workspace-root', join(dir, 'alias', 'state')]);
    assert.equal(result.status, 1);
    assert.equal(existsSync(join(checkout, 'state')), false);
    result = run(['run', '1', '2', '--model', 'some/model']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Finished: Issue #1 \(agent returned\)/);
    assert.match(result.stdout, /Finished: Issue #2 \(agent returned\)/);
    assert.match(result.stdout, /Session complete .*2 agent runs finished, 0 skipped/);
    const runLog = result.stdout.match(/^Log: (.+)$/m)[1];
    assert.ok(runLog.startsWith(join(stateRoot, 'logs')));
    assert.match(readFileSync(runLog, 'utf8'), /pi test/);
    assert.match(readFileSync(runLog, 'utf8'), /Agent output sentinel/);
    assert.match(readFileSync(runLog, 'utf8'), /Agent diagnostic sentinel/);
    assert.match(readFileSync(runLog, 'utf8'), /2 agent runs finished/);
    const root = workspacePath(result.stdout);
    assert.equal(root.startsWith(join(temp, 'lamplight-')), true);
    assert.equal(existsSync(root), false, 'successful runs remove their temporary workspaces');
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 2);
    for (const [index, call] of calls.entries()) {
      assert.equal(call.cwd, join(root, `GH-${index + 1}`));
      assert.ok(call.args.includes('some/model'));
      assert.ok(call.args.includes('--no-approve'));
      assert.equal(call.args.includes('--session-dir'), false);
      assert.equal(call.args.includes('--no-session'), false);
      assert.match(call.args.at(-1), /Default branch: trunk/);
      assert.match(call.args.at(-1), /New PRs start as drafts/);
      assert.match(call.args.at(-1), /PRs must demonstrate the solution visually whenever possible in ## Proof; include before\/after evidence/);
      assert.match(call.args.at(-1), /If applicable visuals cannot be captured or attached, report the blocker explicitly and keep PRs draft/);
    }
    assert.deepEqual(readdirSync(stateRoot), ['logs'], 'sessions and locks stay outside persistent log storage');
    assert.equal(existsSync(repoLock), false);
    const workflow = join(dir, 'custom.md');
    writeFileSync(workflow, 'Custom workflow sentinel');
    result = run(['run', '3', '--workflow', workflow], { LAMPLIGHT_TEST_PI_EXIT: '9' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pi exited with 9/);
    assert.match(result.stdout, /Session failed .*0 agent runs finished/);
    assert.doesNotMatch(result.stdout, /Finished: Issue #3/);
    const customPrompt = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).at(-1).args.at(-1);
    assert.match(customPrompt, /Custom workflow sentinel/);
    assert.match(customPrompt, /PRs must demonstrate the solution visually whenever possible in ## Proof/);
    assert.match(customPrompt, /These evidence rules also apply with a custom workflow/);
    const failedRoot = workspacePath(result.stdout);
    assert.notEqual(failedRoot, root);
    assert.equal(existsSync(join(failedRoot, 'GH-3', '.git')), true);
    assert.ok(result.stderr.includes(`Workspaces kept for recovery: ${failedRoot}`));
    assert.equal(existsSync(repoLock), false);
    result = run(['watch'], { LAMPLIGHT_TEST_PRS: JSON.stringify([pr('Closes #1')]) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gh exited with 7/);
    const afterCheckoutFailure = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(afterCheckoutFailure.length, 4, 'checkout failure must not start a PR agent');
    assert.match(afterCheckoutFailure.at(-1).args.at(-1), /Triage open issues/);
    for (const [issues, selected, plan] of [
      [[], 'QA'],
      [[issue(1)], 'GH-1'],
      [[issue(1), issue(2)], 'GH-2', { issue: 2, prs: [], qa: false, reason: '#1 was already dealt with in its comments; work on #2.' }],
      [[issue(1)], null, { issue: null, prs: [], qa: false, reason: '#1 is obsolete per the existing handoff; wait without another comment.' }],
    ]) {
      const beforeCalls = readFileSync(log, 'utf8').trim().split('\n').length;
      const output = await new Promise((done, fail) => {
        const child = spawn(process.execPath, [cli], {
          cwd: checkout, env: {
            ...env, LAMPLIGHT_TEST_URL: pathToFileURL(checkout).href, LAMPLIGHT_TEST_ISSUES: JSON.stringify(issues),
            ...(plan ? { LAMPLIGHT_TEST_PLAN: JSON.stringify(plan) } : {}),
            ...(selected === null ? { LAMPLIGHT_TEST_PRS: JSON.stringify([pr('Closes #2')]) } : {}),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '', stopping = false;
        const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
        child.stdout.on('data', chunk => {
          output += chunk;
          if (!stopping && output.includes('Sleeping 300s.')) {
            stopping = true;
            const contender = run(['run', '1', '--workspace-root', join(dir, 'contender')], {
              LAMPLIGHT_TEST_URL: pathToFileURL(checkout).href, XDG_STATE_HOME: join(dir, 'other-state'),
            });
            try {
              assert.equal(contender.status, 1);
              assert.match(contender.stderr, /Runner lock exists/);
              assert.equal(readFileSync(join(lockPath(output), 'pid'), 'utf8'), `${child.pid}\n`);
            } catch (err) { fail(err); }
            child.kill('SIGTERM');
          }
        });
        child.stderr.on('data', chunk => { output += chunk; });
        child.on('error', fail);
        child.on('close', code => {
          clearTimeout(timeout);
          if (code === 143) done(output);
          else fail(new Error(`Default loop exited ${code}: ${output}`));
        });
      });
      assert.match(output, /Triaging open issues/);
      assert.match(output, selected ? /Session interrupted .*2 agent runs finished/ : /Session interrupted .*1 agent runs finished/);
      if (selected === 'QA') assert.match(output, /Running idle QA/);
      else if (selected) assert.match(output, new RegExp(`Running #${selected.slice(3)}`));
      else assert.match(output, /No useful issue, PR, or QA action now/);
      if (plan) assert.doesNotMatch(output, /Running #1|Running idle QA|Maintaining PR/);
      const stages = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).slice(beforeCalls);
      assert.equal(stages.length, selected ? 2 : 1);
      assert.match(stages[0].args.at(-1), /Triage open issues/);
      assert.match(stages[0].args.at(-1), /Read issue comments/);
      assert.match(stages[0].args.at(-1), /completed handoff even if the issue remains open/);
      if (selected) assert.match(stages[1].args.at(-1), selected === 'QA' ? /QA this repository/ : new RegExp(`Implement issue #${selected.slice(3)}`));
      if (selected === 'QA') {
        assert.match(stages[1].args.at(-1), /QA findings must show the problem visually whenever applicable, in addition to explaining it/);
        assert.match(stages[1].args.at(-1), /Attach or embed the evidence in the GitHub issue\/report or PR/);
        assert.match(stages[1].args.at(-1), /If visual evidence is not applicable, explain why and provide suitable real runtime evidence instead/);
      }
      const interruptedRoot = workspacePath(output);
      assert.equal(existsSync(join(interruptedRoot, selected || 'queue', '.git')), true);
      assert.equal(existsSync(join(interruptedRoot, 'queue', '.git', 'lamplight-plan.json')), true);
      if (plan) assert.equal(existsSync(join(interruptedRoot, 'GH-1')), false);
      assert.ok(output.includes(`Workspaces kept for recovery: ${interruptedRoot}`));
      assert.notEqual(lockPath(output), repoLock, 'different hosts have separate locks');
      assert.equal(existsSync(lockPath(output)), false);
    }
    for (const plan of [null, {},
      { issue: 99, prs: [], qa: false, reason: 'Unknown issue' },
      { issue: null, prs: [99], qa: false, reason: 'Unknown PR' },
      { issue: 1, prs: [], qa: true, reason: 'Conflicting actions' },
      { issue: null, prs: [], qa: false, reason: '' },
    ]) {
      const beforeCalls = readFileSync(log, 'utf8').trim().split('\n').length;
      result = run(['watch'], { LAMPLIGHT_TEST_PLAN: JSON.stringify(plan) });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid triage plan/);
      assert.doesNotMatch(result.stdout, /Running #|Maintaining PR|Running idle QA/);
      assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, beforeCalls + 1);
    }
    const persistent = join(dir, 'persistent');
    result = run(['run', '4', '--workspace-root', persistent]);
    assert.equal(result.status, 0, result.stderr);
    const persistentRoot = workspacePath(result.stdout);
    assert.equal(persistentRoot, join(persistent, 'github.com', 'example', 'project'));
    assert.equal(existsSync(join(persistentRoot, 'GH-4', '.git')), true);
    result = run(['run', '4', '--workspace-root', persistent]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(workspacePath(result.stdout), persistentRoot);
    for (const signal of [undefined, 'SIGINT', 'SIGTERM']) {
      const pidsFile = join(dir, `hung-${signal || 'timeout'}`);
      const output = await new Promise((done, fail) => {
        const child = spawn(process.execPath, [cli, 'run', '5', '6', '--agent-timeout', signal ? '60' : '1'], {
          cwd: checkout, env: { ...env, LAMPLIGHT_TEST_HANG: pidsFile, LAMPLIGHT_TEST_IGNORE_SIGNALS: signal === 'SIGINT' ? '1' : '' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '', stopping = false;
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
        child.stdout.on('data', chunk => {
          output += chunk;
          if (signal && !stopping && output.includes('Descendants ready')) {
            stopping = true;
            child.kill(signal);
          }
        });
        child.stderr.on('data', chunk => { output += chunk; });
        child.on('error', fail);
        child.on('close', code => {
          clearTimeout(timer);
          try {
            assert.equal(code, signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1, output);
            done(output);
          } catch (err) { fail(err); }
        });
      });
      const pids = readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number);
      assert.equal(pids.length, 3, 'agent, detached tool and detached grandchild all started');
      const running = execFileSync('ps', ['-eo', 'pid=,stat='], { encoding: 'utf8' }).trim().split('\n')
        .map(row => row.trim().split(/\s+/)).filter(([pid, state]) => pids.includes(Number(pid)) && !state.startsWith('Z'));
      assert.deepEqual(running, [], 'no agent/tool processes survive timeout or interruption');
      assert.match(output, signal ? /Session interrupted/ : /pi timed out after 1s/);
      assert.match(output, /0 agent runs finished/);
      assert.doesNotMatch(output, /Running #6/);
      assert.equal(existsSync(join(workspacePath(output), 'GH-5', '.git')), true);
      assert.equal(existsSync(lockPath(output)), false);
    }
    mkdirSync(repoLock);
    writeFileSync(join(repoLock, 'pid'), '123\n');
    result = run(['run', '4']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Runner lock exists/);
    assert.equal(readFileSync(join(repoLock, 'pid'), 'utf8'), '123\n');
    assert.deepEqual(readdirSync(stateRoot), ['logs']);
    assert.equal(git('status', '--porcelain').toString(), before);
  } finally {
    for (const file of readdirSync(dir).filter(name => name.startsWith('hung-'))) {
      for (const pid of readFileSync(join(dir, file), 'utf8').trim().split('\n').map(Number)) {
        try { process.kill(-pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

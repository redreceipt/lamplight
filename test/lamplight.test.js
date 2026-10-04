import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('real CLI: zero-setup dry run, multiple issues, failure propagation, and external state', async () => {
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
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: state, LAMPLIGHT_TEST_LOG: log, LAMPLIGHT_TEST_REPO: checkout };
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
      else if (a[0] === 'pr' && a[1] === 'checkout') process.exit(7);
      else if (a[0] === 'repo' && a[1] === 'clone') {
        execFileSync('git', ['clone', process.env.LAMPLIGHT_TEST_REPO, a[3]]);
        execFileSync('git', ['remote','set-url','origin',url], {cwd:a[3]});
      } else throw Error('Unexpected gh call: '+a.join(' '));
      if (result !== undefined) console.log(JSON.stringify(result));
    `);
    script('pi', `
      const { appendFileSync } = require('node:fs');
      if (process.argv[2] === '--version') console.log('test');
      else {
        appendFileSync(process.env.LAMPLIGHT_TEST_LOG, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+'\\n');
        process.exit(Number(process.env.LAMPLIGHT_TEST_PI_EXIT || 0));
      }
    `);
    const run = (args, extra = {}, entry = cli) => spawnSync(process.execPath, [entry, ...args], { cwd: checkout, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 });
    const root = join(state, 'lamplight', 'github.com', 'example', 'project');
    const before = git('status', '--porcelain').toString();
    symlinkSync(cli, join(bin, 'lamplight'));
    let result = run(['--help'], {}, join(bin, 'lamplight'));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Inspired by OpenAI Symphony/);
    assert.doesNotMatch(result.stdout, /--triage|--qa/);
    result = run(['--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(log), false);
    result = run(['run', '1', '2', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Would run #1/);
    assert.match(result.stdout, /Would run #2/);
    assert.equal(existsSync(state), false);
    assert.equal(existsSync(log), false);
    result = run(['--dry-run'], { LAMPLIGHT_TEST_PRS: JSON.stringify([pr('Closes #1')]) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Would triage/);
    assert.match(result.stdout, /Would maintain PR #99/);
    assert.match(result.stdout, /Would run idle QA/);
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
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 2);
    for (const [index, call] of calls.entries()) {
      assert.equal(call.cwd, join(root, `GH-${index + 1}`));
      assert.ok(call.args.includes('some/model'));
      assert.ok(call.args.includes('--no-approve'));
      assert.equal(call.args[call.args.indexOf('--session-dir') + 1], join(root, 'sessions'));
      assert.match(call.args.at(-1), /Default branch: trunk/);
      assert.match(call.args.at(-1), /New PRs start as drafts/);
    }
    assert.equal(existsSync(join(root, '.lock')), false);
    const workflow = join(dir, 'custom.md');
    writeFileSync(workflow, 'Custom workflow sentinel');
    result = run(['run', '3', '--workflow', workflow], { LAMPLIGHT_TEST_PI_EXIT: '9' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pi exited with 9/);
    assert.match(readFileSync(log, 'utf8'), /Custom workflow sentinel/);
    assert.equal(existsSync(join(root, '.lock')), false);
    result = run(['watch'], { LAMPLIGHT_TEST_PRS: JSON.stringify([pr('Closes #1')]) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gh exited with 7/);
    const afterCheckoutFailure = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(afterCheckoutFailure.length, 4, 'checkout failure must not start a PR agent');
    assert.match(afterCheckoutFailure.at(-1).args.at(-1), /Triage open issues/);
    for (const issues of [[], [issue(1)]]) {
      const output = await new Promise((done, fail) => {
        const child = spawn(process.execPath, [cli], {
          cwd: checkout, env: { ...env, LAMPLIGHT_TEST_URL: pathToFileURL(checkout).href, LAMPLIGHT_TEST_ISSUES: JSON.stringify(issues) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
        child.stdout.on('data', chunk => {
          output += chunk;
          if (output.includes('Sleeping 300s.')) child.kill('SIGTERM');
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
      assert.match(output, issues.length ? /Running #1/ : /Running idle QA/);
      const stages = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).slice(-2);
      assert.match(stages[0].args.at(-1), /Triage open issues/);
      assert.match(stages[1].args.at(-1), issues.length ? /Implement issue #1/ : /QA this repository/);
      assert.equal(existsSync(join(state, 'lamplight', 'example', 'project', '.lock')), false);
    }
    mkdirSync(join(root, '.lock'));
    writeFileSync(join(root, '.lock', 'pid'), '123\n');
    result = run(['run', '4']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Runner lock exists/);
    assert.equal(readFileSync(join(root, '.lock', 'pid'), 'utf8'), '123\n');
    assert.equal(git('status', '--porcelain').toString(), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

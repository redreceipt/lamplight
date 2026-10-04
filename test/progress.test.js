import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createProgress } from '../bin/progress.js';

function stream(isTTY = true, columns = 100, rows = 24) {
  return Object.assign(new EventEmitter(), { isTTY, columns, rows, output: '', write(text) { this.output += text; } });
}

test('dashboard stays fixed, logs output, fits resizes, and restores the terminal once', async () => {
  const term = process.env.TERM;
  process.env.TERM = 'xterm';
  const dir = mkdtempSync(join(tmpdir(), 'lamplight-progress-'));
  const path = join(dir, 'run.log');
  const stdout = stream(), stderr = stream();
  const progress = createProgress({ stdout, stderr });
  try {
    progress.log('startup diagnostic');
    progress.logTo(path);
    progress.repository('example/project');
    progress.phase('Issue #1', 'Fix the API');
    const before = stderr.output;
    await sleep(1100);
    assert.ok(stderr.output.length > before.length, 'refreshes without agent output');
    assert.match(stderr.output, /example\/project/);
    assert.match(stderr.output, /Working     Issue #1/);
    assert.match(stderr.output, /Fix the API/);
    progress.write('partial agent text');
    progress.write(' completed\n');
    progress.write('agent diagnostic\n', stderr);
    assert.equal(stdout.output, '');
    assert.doesNotMatch(stderr.output, /agent text|agent diagnostic|startup diagnostic/);
    progress.finish();
    progress.skip('#2: blocked; skipped.');
    progress.wait(5);
    assert.match(stderr.output, /Next pass in 5s/);
    assert.match(stderr.output, /1 finished · 1 skipped/);
    assert.match(stderr.output, /Previous    Issue #1 finished/);
    assert.match(stderr.output, /Previous    #2: blocked; skipped./);
    stderr.columns = 20;
    stderr.rows = 4;
    stderr.emit('resize');
    const frame = stderr.output.split('\x1b[H').at(-1);
    assert.equal(frame.split('\r\n').length, 3, 'leaves a row free to avoid scrolling');
    assert.ok(frame.replace(/\x1b\[[KJ]/g, '').split('\r\n').every(line => line.length <= 19));
    stderr.columns = 100;
    stderr.rows = 24;
    progress.phase('PR #3', '\x1b[2J\n' + '界'.repeat(100));
    const title = stderr.output.split('\x1b[H').at(-1).split('\r\n')[3];
    assert.ok(title.replace(/\x1b\[K/g, '').replaceAll('界', 'xx').length <= 99, 'wide text fits');
    assert.doesNotMatch(title, /\x1b\[2J|\n/);
    progress.stop('interrupted');
    const stopped = stderr.output;
    progress.stop('failed');
    await sleep(1100);
    assert.equal(stderr.output, stopped, 'no output after shutdown, including a second stop');
    assert.ok(stderr.output.startsWith('\x1b[?1049h\x1b[?25l'));
    assert.ok(stderr.output.endsWith('\x1b[?25h\x1b[?1049l'));
    assert.equal(stderr.listenerCount('resize'), 0);
    assert.match(stdout.output, /Session interrupted .*1 agent runs finished, 1 skipped/);
    assert.ok(stdout.output.includes(`Log: ${path}`));
    assert.match(readFileSync(path, 'utf8'), /startup diagnostic\npartial agent text completed\nagent diagnostic\nFinished: Issue #1/);
    assert.match(readFileSync(path, 'utf8'), /Session interrupted/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    progress.stop('interrupted');
    rmSync(dir, { recursive: true, force: true });
    if (term === undefined) delete process.env.TERM;
    else process.env.TERM = term;
  }
});

test('redirected, dumb, disabled, and verbose terminals stay plain; unfinished work is not counted', () => {
  const term = process.env.TERM;
  try {
    for (const [outTTY, errTTY, terminal, enabled, dashboard] of [
      [false, true, 'xterm', true, true], [true, false, 'xterm', true, true],
      [true, true, 'dumb', true, true], [true, true, 'xterm', false, true],
      [true, true, 'xterm', true, false],
    ]) {
      process.env.TERM = terminal;
      const stdout = stream(outTTY), stderr = stream(errTTY);
      const progress = createProgress({ stdout, stderr, enabled, dashboard });
      progress.phase('Issue #1');
      progress.write('still working');
      progress.stop('failed');
      assert.equal(stderr.output, '');
      assert.doesNotMatch(stdout.output, /\x1b/);
      if (enabled) assert.match(stdout.output, /still working\nSession failed .*0 agent runs finished/);
      else assert.equal(stdout.output, 'still working');
    }
    process.env.TERM = 'xterm';
    const stdout = stream(), stderr = stream();
    const progress = createProgress({ stdout, stderr });
    progress.write('startup failed');
    progress.stop('failed');
    assert.match(stdout.output, /startup failed\nSession failed/, 'early failures retain diagnostics without a log');
    assert.ok(stderr.output.endsWith('\x1b[?25h\x1b[?1049l'));
  } finally {
    if (term === undefined) delete process.env.TERM;
    else process.env.TERM = term;
  }
});

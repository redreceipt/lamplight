import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createProgress } from '../bin/progress.js';

function stream(isTTY = true, columns = 100) {
  return { isTTY, columns, output: '', write(text) { this.output += text; } };
}

test('live progress redraws, yields to partial output, clips on resize, and stops cleanly', async () => {
  const term = process.env.TERM;
  process.env.TERM = 'xterm';
  const stdout = stream(), stderr = stream();
  const progress = createProgress({ stdout, stderr });
  try {
    progress.phase('Issue #1');
    const before = stderr.output;
    await sleep(220);
    assert.ok(stderr.output.length > before.length, 'status refreshes without agent output');
    assert.match(stderr.output, /Issue #1 \| 0 finished, 0 skipped/);
    progress.write('partial agent text');
    const partial = stderr.output;
    await sleep(150);
    assert.equal(stderr.output, partial, 'never draw over an unfinished agent line');
    progress.write(' completed\n');
    assert.ok(stderr.output.length > partial.length);
    progress.write('agent diagnostic\n', stderr);
    assert.match(stderr.output, /agent diagnostic\n/);
    progress.finish();
    progress.skip('#2: blocked; skipped.');
    progress.wait(5);
    assert.match(stderr.output, /Next pass in 5s \| 1 finished, 1 skipped/);
    assert.match(stdout.output, /partial agent text completed\nFinished: Issue #1/);
    stderr.columns = 20;
    progress.phase('Reading issue queue');
    assert.ok(stderr.output.split('\r\x1b[2K').at(-1).length <= 19);
    progress.stop('interrupted');
    const stopped = stderr.output;
    await sleep(150);
    assert.equal(stderr.output, stopped, 'no timer output after shutdown');
    assert.ok(stderr.output.endsWith('\r\x1b[2K'));
    assert.match(stdout.output, /Session interrupted .*1 agent runs finished, 1 skipped/);
  } finally {
    progress.stop('interrupted');
    if (term === undefined) delete process.env.TERM;
    else process.env.TERM = term;
  }
});

test('redirected, dumb, and disabled terminals stay plain; unfinished work is not counted', () => {
  const term = process.env.TERM;
  try {
    for (const [outTTY, errTTY, terminal, enabled] of [
      [false, true, 'xterm', true], [true, false, 'xterm', true],
      [true, true, 'dumb', true], [true, true, 'xterm', false],
    ]) {
      process.env.TERM = terminal;
      const stdout = stream(outTTY), stderr = stream(errTTY);
      const progress = createProgress({ stdout, stderr, enabled });
      progress.phase('Issue #1');
      progress.write('still working');
      progress.stop('failed');
      assert.equal(stderr.output, '');
      assert.doesNotMatch(stdout.output, /\x1b/);
      if (enabled) assert.match(stdout.output, /still working\nSession failed .*0 agent runs finished/);
      else assert.equal(stdout.output, 'still working');
    }
  } finally {
    if (term === undefined) delete process.env.TERM;
    else process.env.TERM = term;
  }
});

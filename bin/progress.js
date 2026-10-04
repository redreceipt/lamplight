// One transient line; ordinary output and completed work stay in scrollback.
export function createProgress({ stdout = process.stdout, stderr = process.stderr, enabled = true } = {}) {
  const interactive = enabled && stdout.isTTY && stderr.isTTY && process.env.TERM !== 'dumb';
  const started = Date.now();
  let phase = 'Checking tools', finished = 0, skipped = 0, frame = 0;
  let visible = false, lineStart = true, wakeAt;
  const elapsed = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  function clear() {
    if (visible) stderr.write('\r\x1b[2K');
    visible = false;
  }
  function render() {
    if (!interactive || !lineStart) return;
    clear();
    const current = wakeAt ? `Next pass in ${Math.max(0, Math.ceil((wakeAt - Date.now()) / 1000))}s` : phase;
    const line = `${'|/-\\'[frame++ % 4]} lamplight ${elapsed()} | ${current} | ${finished} finished, ${skipped} skipped`;
    // ASCII status text keeps column clipping predictable, including narrow terminals.
    stderr.write(line.slice(0, Math.max(0, (stderr.columns || 80) - 1)));
    visible = true;
  }
  function write(data, stream = stdout) {
    clear();
    stream.write(data);
    lineStart = data.endsWith('\n');
    render();
  }
  const log = message => write(`${lineStart ? '' : '\n'}${message}\n`);
  const timer = interactive ? setInterval(render, 100) : undefined;
  timer?.unref();
  render();
  return {
    write, log,
    phase(label) { phase = label; wakeAt = undefined; render(); },
    finish() { finished++; log(`Finished: ${phase} (agent returned).`); },
    skip(message) { skipped++; log(message); },
    wait(seconds) { wakeAt = Date.now() + seconds * 1000; render(); },
    stop(outcome) {
      clearInterval(timer);
      clear();
      if (enabled) stdout.write(`${lineStart ? '' : '\n'}Session ${outcome} (${elapsed()}): ${finished} agent runs finished, ${skipped} skipped.\n`);
    },
  };
}

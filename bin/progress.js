import { closeSync, openSync, writeSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

export function createProgress({ stdout = process.stdout, stderr = process.stderr, enabled = true, dashboard = true } = {}) {
  const interactive = enabled && dashboard && stdout.isTTY && stderr.isTTY && process.env.TERM !== 'dumb';
  const started = Date.now();
  let phase = 'Checking tools', detail = '', repository = '', previous = 'None yet', finished = 0, skipped = 0;
  let lineStart = true, wakeAt, stopped = false, logFile, logPath, pending = '';
  const elapsed = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  function fit(text) {
    let result = '', width = 0;
    for (const char of stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')) {
      // Conservatively budget two columns for non-ASCII, including wide titles.
      width += char.codePointAt(0) > 127 ? 2 : 1;
      if (width > Math.max(0, (stderr.columns ?? 80) - 1)) break;
      result += char;
    }
    return result;
  }
  function render() {
    if (!interactive || stopped) return;
    const current = wakeAt ? `Next pass in ${Math.max(0, Math.ceil((wakeAt - Date.now()) / 1000))}s` : phase;
    const lines = [
      `lamplight${repository ? ` · ${repository}` : ''}  ${elapsed()}`,
      '',
      `  ${wakeAt ? 'Waiting' : 'Working'}     ${current}`,
      `              ${detail}`,
      '',
      `  Agent runs  ${finished} finished · ${skipped} skipped`,
      `  Previous    ${previous}`,
      '',
      `  Ctrl-C stop · ${logPath ? 'details saved to run log' : 'starting up'}`,
    ];
    stderr.write(`\x1b[H${lines.slice(0, Math.max(1, (stderr.rows ?? 24) - 1)).map(line => `${fit(line)}\x1b[K`).join('\r\n')}\x1b[J`);
  }
  function write(data, stream = stdout) {
    if (logFile !== undefined) writeSync(logFile, data);
    else pending += data;
    if (!interactive) stream.write(data);
    lineStart = data.endsWith('\n');
  }
  const log = message => write(`${lineStart ? '' : '\n'}${message}\n`);
  if (interactive) stderr.write('\x1b[?1049h\x1b[?25l');
  const timer = interactive ? setInterval(render, 1000) : undefined;
  timer?.unref();
  if (interactive) stderr.on?.('resize', render);
  render();
  return {
    write, log,
    logTo(path) {
      logFile = openSync(path, 'wx', 0o600);
      logPath = path;
      writeSync(logFile, pending);
      pending = '';
      render();
    },
    repository(name) { repository = name; render(); },
    phase(label, title = '') { phase = label; detail = title; wakeAt = undefined; render(); },
    finish() { finished++; previous = `${phase} finished`; log(`Finished: ${phase} (agent returned).`); render(); },
    skip(message) { skipped++; previous = message; log(message); render(); },
    wait(seconds) { wakeAt = Date.now() + seconds * 1000; detail = ''; render(); },
    stop(outcome) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (interactive) {
        stderr.off?.('resize', render);
        stderr.write('\x1b[?25h\x1b[?1049l');
      }
      try {
        const summary = `Session ${outcome} (${elapsed()}): ${finished} agent runs finished, ${skipped} skipped.\n`;
        if (enabled) {
          stdout.write(`${interactive ? pending : ''}${lineStart || (interactive && !pending) ? '' : '\n'}${summary}${logPath ? `Log: ${logPath}\n` : ''}`);
          if (logFile !== undefined) writeSync(logFile, `\n${summary}`);
        }
      } finally {
        if (logFile !== undefined) closeSync(logFile);
      }
    },
  };
}

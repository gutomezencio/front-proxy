// All user-facing output goes through here. Plain ANSI codes, no color dependency.
// Colors and the spinner animation are off when stdout isn't a TTY or NO_COLOR is set.

const isTTY = () => Boolean(process.stdout.isTTY);

const colorEnabled = () => {
  if (process.env.NO_COLOR) {
    return false;
  }

  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') {
    return true;
  }

  return isTTY();
};

const style = (open, close) => (text) =>
  colorEnabled() ? `\x1b[${open}m${text}\x1b[${close}m` : String(text);

export const colors = {
  green: style(32, 39),
  red: style(31, 39),
  yellow: style(33, 39),
  cyan: style(36, 39),
  dim: style(2, 22),
  bold: style(1, 22),
};

const symbols = {
  success: () => colors.green('✔'),
  error: () => colors.red('✖'),
  warn: () => colors.yellow('⚠'),
  info: () => colors.cyan('ℹ'),
};

// Title line, indented details (an empty string adds a blank line), then a blank line.
const format = (symbol, title, details) =>
  [
    `${symbol} ${colors.bold(title)}`,
    ...details.map((line) => (line === '' ? '' : `  ${line}`)),
    '',
  ].join('\n');

export const success = (title, ...details) =>
  console.log(format(symbols.success(), title, details));

export const error = (title, ...details) =>
  console.error(format(symbols.error(), title, details));

export const warn = (title, ...details) =>
  console.warn(format(symbols.warn(), title, details));

export const info = (title, ...details) =>
  console.log(format(symbols.info(), title, details));

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const showCursor = () => process.stdout.write('\x1b[?25h');

// Animates only while the event loop is free, so wrap async work with it.
export const spinner = (text) => {
  let timer = null;

  if (isTTY()) {
    let frame = 0;
    const draw = () => {
      process.stdout.write(`\r\x1b[2K${colors.cyan(frames[frame])} ${text}`);
      frame = (frame + 1) % frames.length;
    };

    process.stdout.write('\x1b[?25l');
    process.once('exit', showCursor);
    draw();
    timer = setInterval(draw, 80);
  }

  const stop = () => {
    if (!timer) {
      return;
    }

    clearInterval(timer);
    timer = null;
    process.stdout.write('\r\x1b[2K');
    showCursor();
    process.removeListener('exit', showCursor);
  };

  return {
    stop,
    succeed: (title, ...details) => {
      stop();
      success(title, ...details);
    },
    fail: (title, ...details) => {
      stop();
      error(title, ...details);
    },
  };
};

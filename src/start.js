import { spawn } from 'child_process';
import { resolve } from 'path';
import { parseCliArgs } from './cli-args.js';

// yargs prints usage and exits here on a bad command, before any sudo prompt.
const { command, value } = parseCliArgs();

const commandArgs =
  command === 'start'
    ? []
    : [command, ...(value === undefined ? [] : [value])];

const nodeArgs = [resolve(import.meta.dirname, 'proxy-server.js')];

const init = () => {
  // mkcert must run as the current user so its CA lands in the user's CAROOT.
  const requiresSudo = command !== 'list' && command !== 'generate-certs';

  if (requiresSudo) {
    console.log(
      'For usage of the 80 port and access the OS hosts file, you must provide your root password.\n',
    );
  }

  // process.execPath: sudo's secure_path usually doesn't include Homebrew/nvm node.
  const [executable, args] = requiresSudo
    ? ['sudo', [process.execPath, ...nodeArgs, ...commandArgs]]
    : [process.execPath, [...nodeArgs, ...commandArgs]];

  const child = spawn(executable, args, { stdio: 'inherit' });

  child.on('exit', (code) => {
    process.exitCode = code;
  });
};

init();

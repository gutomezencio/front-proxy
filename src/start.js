import { spawn } from 'child_process';
import fs from 'fs';
import { resolve } from 'path';
import { parseCliArgs } from './cli-args.js';
import { getConfigDir } from './config-dir.js';

// yargs prints usage and exits here on a bad command, before any sudo prompt.
const { command, value, persistHosts } = parseCliArgs();

const commandArgs =
  command === 'start'
    ? persistHosts ? ['--persist-hosts'] : []
    : [command, ...(value === undefined ? [] : [value])];

const nodeArgs = [resolve(import.meta.dirname, 'proxy-server.js')];

// Created as the current user, so the config stays the user's and the commands that
// run without sudo (add, remove, generate-certs...) can still write here.
const prepareConfigDir = (configDir) => {
  fs.mkdirSync(resolve(configDir, 'keys'), { recursive: true });

  const proxyHostsPath = resolve(configDir, 'proxyHosts.json');

  if (!fs.existsSync(proxyHostsPath)) {
    fs.writeFileSync(proxyHostsPath, '{}\n');
  }
};

const init = () => {
  const configDir = getConfigDir();

  prepareConfigDir(configDir);

  // Only starting the proxy binds ports 80/443 and edits /etc/hosts (while it runs).
  // The rest stay as the current user; mkcert needs that so its CA lands in the user's CAROOT.
  const requiresSudo = command === 'start';

  if (requiresSudo) {
    console.log(
      'To bind ports 80/443 and add your hosts to /etc/hosts while the proxy runs, you must provide your root password.\n',
    );
  }

  // process.execPath: sudo's secure_path usually doesn't include Homebrew/nvm node.
  // `env` passes the config dir through sudo, which resets HOME and the environment.
  const [executable, args] = requiresSudo
    ? [
        'sudo',
        ['env', `FRONT_PROXY_HOME=${configDir}`, process.execPath, ...nodeArgs, ...commandArgs],
      ]
    : [process.execPath, [...nodeArgs, ...commandArgs]];

  const child = spawn(executable, args, {
    stdio: 'inherit',
    env: { ...process.env, FRONT_PROXY_HOME: configDir },
  });

  // Ctrl+C reaches the child too (same process group, and sudo relays it). Wait for it
  // to clean /etc/hosts and exit, instead of giving the prompt back halfway through.
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => process.on(signal, () => {}));

  child.on('exit', (code) => {
    process.exitCode = code;
  });
};

init();

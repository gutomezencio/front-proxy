import { spawn } from 'child_process';
import fs from 'fs';
import { resolve } from 'path';
import { parseCliArgs } from './cli-args.js';
import { getConfigDir } from './config-dir.js';

// yargs prints usage and exits here on a bad command, before any sudo prompt.
const { command, value } = parseCliArgs();

const commandArgs =
  command === 'start'
    ? []
    : [command, ...(value === undefined ? [] : [value])];

const nodeArgs = [resolve(import.meta.dirname, 'proxy-server.js')];

// Created as the current user so later root writes (add/remove) keep the user's ownership
// and generate-certs, which runs without sudo, can still write here.
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

  // mkcert must run as the current user so its CA lands in the user's CAROOT.
  const requiresSudo = command !== 'list' && command !== 'generate-certs';

  if (requiresSudo) {
    console.log(
      'For usage of the 80 port and access the OS hosts file, you must provide your root password.\n',
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

  child.on('exit', (code) => {
    process.exitCode = code;
  });
};

init();

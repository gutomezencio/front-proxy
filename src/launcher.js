import fs from 'fs';
import { resolve } from 'path';

// How start.js runs proxy-server.js. Kept apart from start.js so it can be tested
// without spawning anything.

const proxyServerPath = resolve(import.meta.dirname, 'proxy-server.js');

// Only starting the proxy binds ports 80/443 and edits /etc/hosts (while it runs).
// The rest stay as the current user; mkcert needs that so its CA lands in the user's CAROOT.
export const requiresSudo = ({ command }) => command === 'start';

// Created as the current user, so the config stays the user's and the commands that
// run without sudo (add, remove, generate-certs...) can still write here.
export const prepareConfigDir = (configDir) => {
  fs.mkdirSync(resolve(configDir, 'keys'), { recursive: true });

  const proxyHostsPath = resolve(configDir, 'proxyHosts.json');

  if (!fs.existsSync(proxyHostsPath)) {
    fs.writeFileSync(proxyHostsPath, '{}\n');
  }
};

// The arguments proxy-server.js gets, rebuilt from the parsed command.
export const commandArgs = ({ command, value, persistHosts, admin }) =>
  command === 'start'
    ? [...(persistHosts ? ['--persist-hosts'] : []), ...(admin === false ? ['--no-admin'] : [])]
    : [command, ...(value === undefined ? [] : [value])];

// Returns [executable, args] for spawn().
// process.execPath: sudo's secure_path usually doesn't include Homebrew/nvm node.
// `env` passes the config dir through sudo, which resets HOME and the environment.
export const childCommand = (parsed, configDir, nodePath = process.execPath) => {
  const nodeArgs = [proxyServerPath, ...commandArgs(parsed)];

  return requiresSudo(parsed)
    ? ['sudo', ['env', `FRONT_PROXY_HOME=${configDir}`, nodePath, ...nodeArgs]]
    : [nodePath, nodeArgs];
};

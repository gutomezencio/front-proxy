import { spawn } from 'child_process';
import { basename, resolve } from 'path';
const cliArgs = require('yargs').argv;
const { add, remove, list, generateCerts } = cliArgs;
let commandArgs = [];

if (add) {
  commandArgs = ['--add', add];
} else if (remove) {
  commandArgs = ['--remove', remove];
} else if (list) {
  commandArgs = ['--list'];
} else if (generateCerts) {
  commandArgs =
    typeof generateCerts === 'string'
      ? ['--generate-certs', generateCerts]
      : ['--generate-certs'];
}

const proxyServerPath = resolve(__dirname, 'proxy-server.js');

// src/ still needs babel-node; dist/ is already compiled and runs on plain node.
const nodeArgs =
  basename(__dirname) === 'src'
    ? [
        resolve(__dirname, '../node_modules/@babel/node/bin/babel-node.js'),
        proxyServerPath,
      ]
    : [proxyServerPath];

const init = () => {
  // mkcert must run as the current user so its CA lands in the user's CAROOT.
  const requiresSudo = !list && !generateCerts;

  if (requiresSudo) {
    console.log(
      'For usage of the 80 port and access the OS hosts file, you must provide your root password.\n',
    );
  }

  // process.execPath: sudo's secure_path usually doesn't include Homebrew/nvm node.
  const [command, args] = requiresSudo
    ? ['sudo', [process.execPath, ...nodeArgs, ...commandArgs]]
    : [process.execPath, [...nodeArgs, ...commandArgs]];

  const child = spawn(command, args, { stdio: 'inherit' });

  child.on('exit', (code) => {
    process.exitCode = code;
  });
};

init();

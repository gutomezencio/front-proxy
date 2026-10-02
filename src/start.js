import { spawn } from 'child_process';
import { parseCliArgs } from './cli-args.js';
import { getConfigDir } from './config-dir.js';
import { childCommand, prepareConfigDir, requiresSudo } from './launcher.js';
import { colors, info } from './output.js';

// yargs prints usage and exits here on a bad command, before any sudo prompt.
const parsed = parseCliArgs();
const configDir = getConfigDir();

prepareConfigDir(configDir);

if (requiresSudo(parsed)) {
  info(
    'front-proxy needs your password',
    colors.dim('To bind ports 80/443 and add your hosts to /etc/hosts while the proxy runs.'),
  );
}

const [executable, args] = childCommand(parsed, configDir);
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

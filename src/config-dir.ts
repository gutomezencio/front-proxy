import os from 'os';
import { join } from 'path';

// Lives outside the package so `npm update -g` and reinstalls keep the config and certs.
// start.js resolves it as the real user and passes it to the sudo child through FRONT_PROXY_HOME.
export const getConfigDir = () =>
  process.env.FRONT_PROXY_HOME || join(os.homedir(), '.front-proxy');

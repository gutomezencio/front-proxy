import http from 'http';
import type { ProxyState } from './hosts-config.js';
import { adminHost } from './hosts-validation.js';

// Talks to the admin API of a running proxy, the way the admin page does: same Host, Origin,
// JSON body and per-run token (read from the page). The proxy runs as root, so this is how a
// process running as the user (the MCP server) asks it to apply the config.

export type ProxyReach =
  | { running: false }
  | { running: true; admin: false; problem: string }
  | { running: true; admin: true; state: ProxyState };

export type ApplyResult = ProxyState & { httpsNeedsRestart: boolean };

export type AdminClient = {
  reach: () => Promise<ProxyReach>;
  apply: () => Promise<ApplyResult>;
};

type Response = { status: number; body: string };

export const notRunning = 'front-proxy is not running. Ask the user to start it with `front-proxy` (it needs sudo).';
export const noAdmin =
  "front-proxy is running without its admin page (started with --no-admin), so changes can't be applied from here. Ask the user to restart front-proxy.";

const parseJson = (body: string): Record<string, unknown> => {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
};

export const createAdminClient = ({ port = 80, timeout = 3000 } = {}): AdminClient => {
  const request = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
    new Promise<Response>((done, fail) => {
      const req = http.request(
        { host: '127.0.0.1', port, method, path, timeout, headers: { host: adminHost, ...headers } },
        (res) => {
          let text = '';

          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => done({ status: res.statusCode ?? 0, body: text }));
        },
      );

      req.on('timeout', () => req.destroy(new Error(`No answer from 127.0.0.1:${port} after ${timeout}ms`)));
      req.on('error', fail);
      req.end(body);
    });

  // Connection refused means nothing listens on the port: the proxy isn't running.
  const sendToRunning = async (...args: Parameters<typeof request>) => {
    try {
      return await request(...args);
    } catch (err) {
      throw (err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? new Error(notRunning) : err;
    }
  };

  // Never throws: the MCP tools use it to say what to do next.
  const reach = async (): Promise<ProxyReach> => {
    let response: Response;

    try {
      response = await sendToRunning('GET', '/api/state');
    } catch (err) {
      const { message } = err as Error;

      return message === notRunning ? { running: false } : { running: true, admin: false, problem: message };
    }

    // Without the admin page, the proxy's catch-all answers 502 for the admin host.
    if (response.status !== 200) {
      return { running: true, admin: false, problem: noAdmin };
    }

    return { running: true, admin: true, state: JSON.parse(response.body) };
  };

  const apply = async (): Promise<ApplyResult> => {
    const page = await sendToRunning('GET', '/');
    const [, token] = page.body.match(/name="front-proxy-token" content="([a-f0-9]{64})"/) ?? [];

    if (!token) {
      throw new Error(noAdmin);
    }

    const response = await sendToRunning(
      'POST',
      '/api/apply',
      {
        origin: `http://${adminHost}`,
        'content-type': 'application/json',
        'x-front-proxy-token': token,
      },
      '{}',
    );

    const data = parseJson(response.body);

    if (response.status !== 200) {
      throw new Error(String(data.error ?? `The proxy answered ${response.status}`));
    }

    return data as ApplyResult;
  };

  return { reach, apply };
};

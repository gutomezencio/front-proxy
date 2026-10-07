import type { Lifecycle, ResponseToolkit, RouteDefMethods, RouteOptions, Server as HapiServer } from '@hapi/hapi';
import { randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import { addHost, getState, hostStatuses, removeHost, setHostPort, type ConfigChange } from './hosts-config.js';
import { adminHost, hostInputSchema, normalizeHost, parseBody, portSchema } from './hosts-validation.js';
import { colors, info } from './output.js';
import type Server from './server.js';

// The admin page at http(s)://front-proxy.localhost, served by the running proxy (as root).
// Requests must come from this machine, with the admin Host header (vhost), and changes also
// need the page's Origin, a JSON body and the per-run token rendered into the page.

// src/admin in the tests, dist/admin once built (the build copies the static files there).
const adminDir = resolve(import.meta.dirname, 'admin');
const tokenPlaceholder = '__FRONT_PROXY_TOKEN__';

const addHostBody = z.object({ host: hostInputSchema, port: portSchema });
const setPortBody = z.object({ port: portSchema });

// One token per proxy run, shared by the HTTP and HTTPS servers.
const token = randomBytes(32).toString('hex');

// Only these files are served; request paths are never joined into file paths.
const staticFiles: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/lib.js': { file: 'lib.js', type: 'text/javascript; charset=utf-8' },
  '/icons.js': { file: 'icons.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
  '/vendor/pico.min.css': { file: 'vendor/pico.min.css', type: 'text/css; charset=utf-8' },
};

const securityHeaders = {
  // Pico's form controls use data: SVG icons.
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

const allowedOrigins = [`http://${adminHost}`, `https://${adminHost}`];
const loopbackAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const mutatingMethods = ['post', 'put', 'patch', 'delete'];

const isToken = (value: unknown) => {
  const given = Buffer.from(String(value || ''));
  const expected = Buffer.from(token);

  return given.length === expected.length && timingSafeEqual(given, expected);
};

const reject = (h: ResponseToolkit, code: number, message: string) => h.response({ error: message }).code(code).takeover();

// Runs before the payload is read, so rejected requests never get parsed.
const guard: Lifecycle.Method = (request, h) => {
  if (!loopbackAddresses.includes(request.info.remoteAddress)) {
    return reject(h, 403, 'The admin page only answers requests from this machine');
  }

  if (!mutatingMethods.includes(request.method)) {
    return h.continue;
  }

  if (!allowedOrigins.includes(String(request.headers.origin))) {
    return reject(h, 403, 'Changes must come from the admin page');
  }

  if (!/^application\/json\s*(;|$)/i.test(String(request.headers['content-type'] ?? ''))) {
    return reject(h, 415, 'Send the body as application/json');
  }

  if (!isToken(request.headers['x-front-proxy-token'])) {
    return reject(h, 403, 'Missing or invalid token. Reload the admin page');
  }

  return h.continue;
};

const addSecurityHeaders: Lifecycle.Method = (request, h) => {
  const { response } = request;
  const headers = 'isBoom' in response && response.isBoom ? response.output.headers : null;

  Object.entries(securityHeaders).forEach(([name, value]) => {
    if (headers) {
      headers[name] = value;
    } else {
      (response as Exclude<typeof response, Error>).header(name, value);
    }
  });

  return h.continue;
};

// Turns a failed config change into its API response.
const changeError = (h: ResponseToolkit, change: Extract<ConfigChange, { ok: false }>) =>
  h.response({ error: change.error }).code(change.status);

export const registerAdmin = (server: HapiServer, proxy: Server) => {
  const routeOptions: RouteOptions = {
    ext: {
      onPreAuth: { method: guard },
      onPreResponse: { method: addSecurityHeaders },
    },
  };

  const jsonOptions: RouteOptions = {
    ...routeOptions,
    payload: { maxBytes: 1024, parse: true, allow: 'application/json' },
  };

  const route = (method: RouteDefMethods | '*', path: string, handler: Lifecycle.Method, options = routeOptions) =>
    server.route({ method, path, vhost: adminHost, options: { ...options, handler } });

  Object.entries(staticFiles).forEach(([path, { file, type }]) => {
    route('GET', path, (request, h) => {
      let content: Buffer | string = fs.readFileSync(resolve(adminDir, file));

      if (file === 'index.html') {
        content = content.toString('utf8').replace(tokenPlaceholder, token);
      }

      return h.response(content).type(type);
    });
  });

  route('GET', '/api/state', () => getState(proxy));

  route('GET', '/api/status', () =>
    hostStatuses({ ...(proxy.activeHosts ?? {}), ...proxy.loadProxyHosts({ quiet: true }) }),
  );

  route(
    'POST',
    '/api/hosts',
    (request, h) => {
      const { body, error: bodyError } = parseBody(addHostBody, request.payload);

      if (bodyError !== undefined) {
        return h.response({ error: bodyError }).code(400);
      }

      const change = addHost(proxy, body.host, body.port);

      if (!change.ok) {
        return changeError(h, change);
      }

      info('Host added from the admin page', `${colors.cyan(body.host)} → 127.0.0.1:${body.port}`);

      return h.response(getState(proxy)).code(201);
    },
    jsonOptions,
  );

  route(
    'PUT',
    '/api/hosts/{host}',
    (request, h) => {
      const { body, error: bodyError } = parseBody(setPortBody, request.payload);

      if (bodyError !== undefined) {
        return h.response({ error: bodyError }).code(400);
      }

      const host = normalizeHost(request.params.host);
      const change = setHostPort(proxy, host, body.port);

      if (!change.ok) {
        return changeError(h, change);
      }

      info('Host changed from the admin page', `${colors.cyan(host)} → 127.0.0.1:${body.port}`);

      return getState(proxy);
    },
    jsonOptions,
  );

  route(
    'DELETE',
    '/api/hosts/{host}',
    (request, h) => {
      const host = normalizeHost(request.params.host);
      const change = removeHost(proxy, host);

      if (!change.ok) {
        return changeError(h, change);
      }

      info('Host removed from the admin page', colors.cyan(host));

      return getState(proxy);
    },
    // No body, but the same guard (JSON Content-Type included) applies.
    jsonOptions,
  );

  route(
    'POST',
    '/api/apply',
    (request, h) => {
      try {
        const { httpsNeedsRestart } = proxy.applyConfig();

        return { ...getState(proxy), httpsNeedsRestart };
      } catch (err) {
        return h.response({ error: `Couldn't apply the config: ${(err as Error).message}` }).code(500);
      }
    },
    jsonOptions,
  );

  // Unknown admin paths stay on the admin host instead of reaching the proxy route.
  route('*', '/{path*}', (request, h) => h.response({ error: 'Not found' }).code(404));
};

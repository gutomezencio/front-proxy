import { randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import net from 'net';
import { resolve } from 'path';
import { adminHost, normalizeHost, validateHost, validatePort } from './hosts-validation.js';
import { colors, info } from './output.js';

// The admin page at http(s)://front-proxy.localhost, served by the running proxy (as root).
// Requests must come from this machine, with the admin Host header (vhost), and changes also
// need the page's Origin, a JSON body and the per-run token rendered into the page.

const adminDir = resolve(import.meta.dirname, 'admin');
const tokenPlaceholder = '__FRONT_PROXY_TOKEN__';
const maxHosts = 100;

// One token per proxy run, shared by the HTTP and HTTPS servers.
const token = randomBytes(32).toString('hex');

// Only these files are served; request paths are never joined into file paths.
const staticFiles = {
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

const isToken = (value) => {
  const given = Buffer.from(String(value || ''));
  const expected = Buffer.from(token);

  return given.length === expected.length && timingSafeEqual(given, expected);
};

const reject = (h, code, message) => h.response({ error: message }).code(code).takeover();

// Runs before the payload is read, so rejected requests never get parsed.
const guard = (request, h) => {
  if (!loopbackAddresses.includes(request.info.remoteAddress)) {
    return reject(h, 403, 'The admin page only answers requests from this machine');
  }

  if (!mutatingMethods.includes(request.method)) {
    return h.continue;
  }

  if (!allowedOrigins.includes(request.headers.origin)) {
    return reject(h, 403, 'Changes must come from the admin page');
  }

  if (!/^application\/json\s*(;|$)/i.test(request.headers['content-type'] || '')) {
    return reject(h, 415, 'Send the body as application/json');
  }

  if (!isToken(request.headers['x-front-proxy-token'])) {
    return reject(h, 403, 'Missing or invalid token. Reload the admin page');
  }

  return h.continue;
};

const addSecurityHeaders = (request, h) => {
  const { response } = request;
  const headers = response.isBoom ? response.output.headers : null;

  Object.entries(securityHeaders).forEach(([name, value]) => {
    if (headers) {
      headers[name] = value;
    } else {
      response.header(name, value);
    }
  });

  return h.continue;
};

// Same comparison the page uses to mark pending changes.
const sameHosts = (a, b) => {
  const keys = Object.keys(a);

  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (host) => Object.hasOwn(b, host) && a[host].port === b[host].port && a[host].cert === b[host].cert,
    )
  );
};

// Resolves to whether something accepts connections on 127.0.0.1:<port>.
const isListening = (port) =>
  new Promise((done) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (up) => {
      socket.destroy();
      done(up);
    };

    socket.setTimeout(300, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

// Returns the body fields, or an error message when it has missing or unknown fields.
const readBody = (payload, fields) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'Send a JSON object' };
  }

  const unknown = Object.keys(payload).filter((key) => !fields.includes(key));

  if (unknown.length) {
    return { error: `Unknown fields: ${unknown.join(', ')}` };
  }

  const missing = fields.filter((field) => payload[field] === undefined);

  if (missing.length) {
    return { error: `Missing fields: ${missing.join(', ')}` };
  }

  return { body: payload };
};

export const registerAdmin = (server, proxy) => {
  const describe = (hosts) =>
    Object.fromEntries(
      Object.entries(hosts).map(([host, entry]) => [host, { ...entry, certStatus: proxy.certStatus(entry) }]),
    );

  // For active hosts, 'own' means the running proxy loaded the cert (applyConfig() or start()),
  // not just that its files exist now, e.g. right after `generate-certs` filled in missing files.
  const describeActive = (hosts) =>
    Object.fromEntries(
      Object.entries(hosts).map(([host, entry]) => {
        let certStatus = 'default';

        if (entry.cert) {
          certStatus = proxy.secureContexts?.[host] ? 'own' : 'missing';
        }

        return [host, { ...entry, certStatus }];
      }),
    );

  const getState = () => {
    const config = describe(proxy.loadProxyHosts({ quiet: true }));
    const active = describeActive(proxy.activeHosts ?? {});
    const certsToLoad = Object.keys(config).some(
      (host) => config[host].certStatus === 'own' && active[host] && active[host].certStatus !== 'own',
    );

    return {
      adminHost,
      https: Boolean(proxy.ServerHTTPS),
      active,
      config,
      pending: !sameHosts(config, active) || certsToLoad,
    };
  };

  // Reads proxyHosts.json fresh, so changes made with the CLI meanwhile aren't lost.
  const findHost = (rawHost) => {
    const host = normalizeHost(rawHost);
    const config = proxy.loadProxyHosts({ quiet: true });

    return { host, config, exists: Object.hasOwn(config, host) };
  };

  const routeOptions = {
    ext: {
      onPreAuth: { method: guard },
      onPreResponse: { method: addSecurityHeaders },
    },
  };

  const jsonOptions = {
    ...routeOptions,
    payload: { maxBytes: 1024, parse: true, allow: 'application/json' },
  };

  const route = (method, path, handler, options = routeOptions) =>
    server.route({ method, path, vhost: adminHost, options: { ...options, handler } });

  Object.entries(staticFiles).forEach(([path, { file, type }]) => {
    route('GET', path, (request, h) => {
      let content = fs.readFileSync(resolve(adminDir, file));

      if (file === 'index.html') {
        content = content.toString('utf8').replace(tokenPlaceholder, token);
      }

      return h.response(content).type(type);
    });
  });

  route('GET', '/api/state', () => getState());

  route('GET', '/api/status', async () => {
    const hosts = { ...(proxy.activeHosts ?? {}), ...proxy.loadProxyHosts({ quiet: true }) };
    const entries = await Promise.all(
      Object.entries(hosts).map(async ([host, { port }]) => [host, (await isListening(port)) ? 'up' : 'down']),
    );

    return Object.fromEntries(entries);
  });

  route(
    'POST',
    '/api/hosts',
    (request, h) => {
      const { body, error: bodyError } = readBody(request.payload, ['host', 'port']);

      if (bodyError) {
        return h.response({ error: bodyError }).code(400);
      }

      const { host, config, exists } = findHost(body.host);
      const hostError = validateHost(host);
      const { port, error: portError } = validatePort(body.port);

      if (hostError || portError) {
        return h.response({ error: hostError || portError }).code(400);
      }

      if (exists) {
        return h.response({ error: `${host} is already added` }).code(409);
      }

      if (Object.keys(config).length >= maxHosts) {
        return h.response({ error: `front-proxy supports up to ${maxHosts} hosts` }).code(400);
      }

      proxy.saveProxyHosts({ ...config, [host]: proxy.hostEntry(host, port) });
      info('Host added from the admin page', `${colors.cyan(host)} → 127.0.0.1:${port}`);

      return h.response(getState()).code(201);
    },
    jsonOptions,
  );

  route(
    'PUT',
    '/api/hosts/{host}',
    (request, h) => {
      const { body, error: bodyError } = readBody(request.payload, ['port']);

      if (bodyError) {
        return h.response({ error: bodyError }).code(400);
      }

      const { host, config, exists } = findHost(request.params.host);

      if (!exists) {
        return h.response({ error: `${host} isn't configured` }).code(404);
      }

      const { port, error: portError } = validatePort(body.port);

      if (portError) {
        return h.response({ error: portError }).code(400);
      }

      proxy.saveProxyHosts({ ...config, [host]: { ...config[host], port } });
      info('Host changed from the admin page', `${colors.cyan(host)} → 127.0.0.1:${port}`);

      return getState();
    },
    jsonOptions,
  );

  route(
    'DELETE',
    '/api/hosts/{host}',
    (request, h) => {
      const { host, config, exists } = findHost(request.params.host);

      if (!exists) {
        return h.response({ error: `${host} isn't configured` }).code(404);
      }

      const { [host]: _, ...rest } = config;

      proxy.saveProxyHosts(rest);
      info('Host removed from the admin page', colors.cyan(host));

      return getState();
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

        return { ...getState(), httpsNeedsRestart };
      } catch (err) {
        return h.response({ error: `Couldn't apply the config: ${err.message}` }).code(500);
      }
    },
    jsonOptions,
  );

  // Unknown admin paths stay on the admin host instead of reaching the proxy route.
  route('*', '/{path*}', (request, h) => h.response({ error: 'Not found' }).code(404));
};

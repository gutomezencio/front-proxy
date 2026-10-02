import Hapi from '@hapi/hapi';
import h2o2 from '@hapi/h2o2';
import fs from 'fs';
import tls from 'tls';
import { execFile, execFileSync } from 'child_process';
import { dirname, resolve } from 'path';
import { promisify } from 'util';
import { registerAdmin } from './admin.js';
import { getConfigDir } from './config-dir.js';
import { adminHost, validateCertName, validateHost, validatePort } from './hosts-validation.js';
import { colors, error, info, spinner, success, warn } from './output.js';

const execFileAsync = promisify(execFile);

const hostsFileMarker = (host) => `# > ${host} < Host added by front-proxy`;

// The proxy's /etc/hosts entries live between these lines, only while it runs.
const hostsBlockStart = '# <FRONT-PROXY-HOSTS>';
const hostsBlockEnd = '# </FRONT-PROXY-HOSTS>';

const hostsFileMarkerLine = /^# > \S+ < Host added by front-proxy$/;
const hostsEntryLine = /^127\.0\.0\.1\s+\S+\s*$/;

const buildHostsBlock = (hosts) =>
  [
    hostsBlockStart,
    ...hosts.flatMap((host) => [hostsFileMarker(host), `127.0.0.1 ${host}`]),
    hostsBlockEnd,
  ].join('\n');

const stopSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const restartNote = colors.dim(
  `If the proxy is running, restart it or click Apply now at http://${adminHost} to apply this.`,
);

// Aligned "host  →  :port" rows, with the cert dimmed when there is one.
const hostRows = (proxyHosts) => {
  const hosts = Object.keys(proxyHosts);
  const width = Math.max(...hosts.map((host) => host.length));

  return hosts.map((host) => {
    const { port, cert } = proxyHosts[host];
    const certInfo = cert ? colors.dim(`   cert: ${cert}`) : '';

    return `${colors.cyan(host.padEnd(width))}  →  :${port}${certInfo}`;
  });
};

const defaultCertName = 'default';

// Written as the first key of proxyHosts.json; keys starting with "$" are not hosts.
const proxyHostsComment =
  'front-proxy hosts: { "<domain>": { "port": <local port>, "cert": "<name>" } }. Managed by `front-proxy add` / `remove` / `generate-certs`. "cert" is optional and points to keys/_private-<name>-{cert,key}.pem, next to this file.';

export default class Server {
  constructor() {
    this.hostFilePath = resolve('/', 'etc/hosts');
    const configDir = getConfigDir();

    this.proxyHostsPath = resolve(configDir, 'proxyHosts.json');
    this.keysPath = resolve(configDir, 'keys');
    // Set by start(); off for the CLI commands and the tests.
    this.adminEnabled = false;
    // Tests use port 0 (a random free port) and a fake mkcert.
    this.ports = { http: 80, https: 443 };
    this.mkcertPath = 'mkcert';
    this.proxyHosts = this.loadProxyHosts();
  }

  // Entries that don't validate are skipped, so a hand-edited file can't inject lines
  // into /etc/hosts or point "cert" outside the keys folder.
  loadProxyHosts({ quiet = false } = {}) {
    if (!fs.existsSync(this.proxyHostsPath)) {
      return {};
    }

    const config = JSON.parse(fs.readFileSync(this.proxyHostsPath, 'utf8'));
    const hosts = {};

    Object.keys(config)
      .filter((key) => !key.startsWith('$'))
      .forEach((key) => {
        const { port, cert } = config[key] || {};
        const problem =
          validateHost(key) ||
          validatePort(port).error ||
          (cert === undefined ? null : validateCertName(cert));

        if (problem) {
          if (!quiet) {
            warn(`Skipping "${key}" in ${this.proxyHostsPath}`, problem);
          }
          return;
        }

        hosts[key] = cert === undefined ? { port: Number(port) } : { port: Number(port), cert };
      });

    return hosts;
  }

  saveProxyHosts(proxyHosts) {
    this.proxyHosts = proxyHosts;
    fs.mkdirSync(dirname(this.proxyHostsPath), { recursive: true });
    fs.writeFileSync(
      this.proxyHostsPath,
      `${JSON.stringify({ $comment: proxyHostsComment, ...proxyHosts }, null, 2)}\n`,
    );
  }

  getCertPaths(name) {
    return {
      cert: resolve(this.keysPath, `_private-${name}-cert.pem`),
      key: resolve(this.keysPath, `_private-${name}-key.pem`),
    };
  }

  // A new host uses the cert named after it, when `generate-certs <host>` already created it.
  hostEntry(host, port) {
    return this.readCert(host) ? { port, cert: host } : { port };
  }

  // 'own' (its cert files exist), 'missing' (cert set, files not found) or 'default'.
  certStatus({ cert }) {
    if (!cert) {
      return 'default';
    }

    return this.readCert(cert) ? 'own' : 'missing';
  }

  readCert(name) {
    const { cert, key } = this.getCertPaths(name);

    if (!fs.existsSync(cert) || !fs.existsSync(key)) {
      return null;
    }

    return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
  }

  getSecureContexts(proxyHosts = this.proxyHosts) {
    const contexts = {};

    Object.keys(proxyHosts).forEach((host) => {
      const { cert: certName } = proxyHosts[host];

      if (!certName) {
        return;
      }

      const certFiles = this.readCert(certName);

      if (!certFiles) {
        warn(
          `Cert "${certName}" for ${host} not found`,
          `Looked in ${this.keysPath}. Using the default cert for now.`,
          `Create it with ${colors.cyan(`front-proxy generate-certs ${host}`)}`,
        );
        return;
      }

      contexts[host] = tls.createSecureContext(certFiles);
    });

    return contexts;
  }

  async start({ persistHosts = false, admin = true } = {}) {
    this.persistHosts = persistHosts;
    this.adminEnabled = admin;
    // What's routed and in /etc/hosts. proxyHosts.json can change while running (CLI or
    // admin page); applyConfig() makes those changes active.
    this.activeHosts = this.proxyHosts;
    stopSignals.forEach((signal) => process.on(signal, () => this.stop({ fromSignal: true })));

    // Leftovers from a run that didn't stop cleanly, or from --persist-hosts.
    this.cleanHostsFile();

    // Before the spinner, so its warnings don't land on the spinner line.
    this.secureContexts = this.getSecureContexts(this.activeHosts);

    this.startSpinner = spinner('Starting front-proxy…');

    try {
      await this.startServers();
      this.writeHostsFile();
    } catch (err) {
      this.startSpinner.fail("front-proxy couldn't start", err.message);
      this.persistHosts = false;
      process.exitCode = 1;

      return this.stop();
    }

    const httpsLine = this.ServerHTTPS
      ? `${colors.bold('HTTPS')}  :${this.ports.https}`
      : `${colors.bold('HTTPS')}  ${colors.yellow(`disabled: run ${colors.cyan('front-proxy generate-certs')} to enable it`)}`;
    const hostLines = Object.keys(this.proxyHosts).length
      ? hostRows(this.proxyHosts)
      : [colors.yellow(`No hosts configured. Add one with ${colors.cyan('front-proxy add <host:port>')}`)];
    const hostsNote = this.persistHosts
      ? `Hosts added to ${this.hostFilePath}, and kept there after stopping (--persist-hosts).`
      : `Hosts added to ${this.hostFilePath} until the proxy stops.`;
    const adminLines = this.adminEnabled
      ? ['', `${colors.bold('Admin')}  ${colors.cyan(`http://${adminHost}`)}`]
      : [];

    this.startSpinner.succeed(
      'front-proxy is running',
      '',
      `${colors.bold('HTTP')}   :${this.ports.http}`,
      httpsLine,
      '',
      ...hostLines,
      ...adminLines,
      '',
      colors.dim(hostsNote),
      colors.dim('Press Ctrl+C to stop.'),
    );
  }

  async startServers() {
    const defaultCert = this.readCert(defaultCertName);

    this.ServerHTTP = Hapi.server({
      port: this.ports.http,
    });
    await this.startServer(this.ServerHTTP);

    // Without a default cert, HTTPS stays off; start() says so in its summary.
    if (!defaultCert) {
      return;
    }

    // The default cert is used for hosts without their own "cert".
    this.tls = {
      ...defaultCert,
      SNICallback: (servername, cb) => cb(null, this.secureContexts?.[servername]),
    };

    this.ServerHTTPS = Hapi.server({
      port: this.ports.https,
      tls: this.tls,
      routes: {
        security: {
          hsts: {
            includeSubDomains: true,
            preload: true,
            maxAge: 15768000,
          },
        },
      },
    });
    await this.startServer(this.ServerHTTPS);
  }

  async stop({ fromSignal = false } = {}) {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    this.startSpinner?.stop();
    // Ctrl+C leaves "^C" on the current line.
    if (fromSignal) {
      console.log('');
    }

    const stopSpinner = spinner('Stopping front-proxy…');
    let hostsNote = `Hosts kept in ${this.hostFilePath} (--persist-hosts).`;

    // Synchronous and first, so /etc/hosts is clean even if stopping Hapi hangs.
    if (!this.persistHosts) {
      try {
        this.cleanHostsFile();
        hostsNote = `Hosts removed from ${this.hostFilePath}.`;
      } catch (err) {
        stopSpinner.stop();
        error(`Couldn't clean ${this.hostFilePath}`, err.message);
        hostsNote = `Hosts may still be in ${this.hostFilePath}. The next start cleans them.`;
      }
    }

    await Promise.allSettled(
      [this.ServerHTTP, this.ServerHTTPS]
        .filter(Boolean)
        .map((server) => server.stop({ timeout: 1000 })),
    );

    stopSpinner.succeed('front-proxy stopped', colors.dim(hostsNote));
    process.exit();
  }

  // Reloads proxyHosts.json into the running proxy: routes, SNI certs and /etc/hosts.
  // Returns whether HTTPS still needs a restart (it only starts when the default cert exists).
  applyConfig() {
    const proxyHosts = this.loadProxyHosts();

    this.proxyHosts = proxyHosts;
    this.activeHosts = proxyHosts;
    this.secureContexts = this.getSecureContexts(proxyHosts);
    this.writeHostsFile();

    const hostLines = Object.keys(proxyHosts).length
      ? hostRows(proxyHosts)
      : [colors.yellow('No hosts configured.')];

    success('Config applied', '', ...hostLines);

    return { httpsNeedsRestart: !this.ServerHTTPS && Boolean(this.readCert(defaultCertName)) };
  }

  async startServer(server) {
    // start() sets it; tests call startServer() directly with proxyHosts only.
    this.activeHosts ??= this.proxyHosts;

    await server.register({ plugin: h2o2 });

    if (this.adminEnabled) {
      registerAdmin(server, this);
    }

    const proxy = this;

    server.route({
      method: '*',
      path: '/{path*}',
      options: {
        handler(request, h) {
          const [host] = (request.headers.host || '').split(':');
          // hasOwn: a Host like "constructor" must not match Object.prototype.
          const target = Object.hasOwn(proxy.activeHosts, host) ? proxy.activeHosts[host] : null;

          if (!target) {
            const adminHint = proxy.adminEnabled ? ` Manage the hosts at http://${adminHost}` : '';

            return h
              .response(`front-proxy: no proxy rule for host "${host}".${adminHint}`)
              .code(502);
          }

          return h.proxy({
            port: target.port,
            host: '127.0.0.1',
            passThrough: true,
            rejectUnauthorized: false,
          });
        },
        payload: {
          output: 'stream',
          parse: false,
        },
      },
    });

    await server.start();
  }

  getHostFileContent() {
    return fs.readFileSync(this.hostFilePath, 'utf8');
  }

  // Removes the front-proxy block and the per-host entries older versions wrote
  // outside of it. Lines the user wrote by hand are kept.
  cleanHostsFile() {
    const content = this.getHostFileContent();
    const lines = content.split('\n');
    const kept = [];
    const isLine = (line, expected) =>
      line !== undefined && line.replace(/\r$/, '') === expected;
    const matches = (line, regex) =>
      line !== undefined && regex.test(line.replace(/\r$/, ''));
    // Drops the blank line that was written before a removed entry.
    const dropBlankLine = () => {
      if (kept.length > 0 && kept[kept.length - 1].trim() === '') {
        kept.pop();
      }
    };

    for (let i = 0; i < lines.length; i += 1) {
      if (isLine(lines[i], hostsBlockStart)) {
        dropBlankLine();

        const end = lines.findIndex((line, j) => j > i && isLine(line, hostsBlockEnd));

        if (end !== -1) {
          i = end;
        } else {
          // No end line: only drop the entries right after the start line.
          while (
            matches(lines[i + 1], hostsFileMarkerLine) &&
            matches(lines[i + 2], hostsEntryLine)
          ) {
            i += 2;
          }
        }
      } else if (
        matches(lines[i], hostsFileMarkerLine) &&
        matches(lines[i + 1], hostsEntryLine)
      ) {
        dropBlankLine();
        i += 1;
      } else {
        kept.push(lines[i]);
      }
    }

    let cleaned = kept.join('\n');

    if (content.endsWith('\n') && !cleaned.endsWith('\n')) {
      cleaned += '\n';
    }

    if (cleaned !== content) {
      fs.writeFileSync(this.hostFilePath, cleaned);
    }
  }

  writeHostsFile() {
    this.cleanHostsFile();

    const hosts = [
      ...Object.keys(this.activeHosts ?? this.proxyHosts),
      ...(this.adminEnabled ? [adminHost] : []),
    ];

    if (hosts.length === 0) {
      return;
    }

    const content = this.getHostFileContent();
    const separator = content === '' || content.endsWith('\n') ? '\n' : '\n\n';

    fs.appendFileSync(this.hostFilePath, `${separator}${buildHostsBlock(hosts)}\n`);
  }

  add({ host, port }) {
    if (Object.hasOwn(this.proxyHosts, host)) {
      return error(
        `${host} is already added`,
        `Remove it first with ${colors.cyan(`front-proxy remove ${host}`)}, or pick another host.`,
      );
    }

    this.saveProxyHosts({
      ...this.proxyHosts,
      [host]: this.hostEntry(host, port),
    });

    return success(
      'Host added',
      `${colors.cyan(host)} → 127.0.0.1:${port}`,
      '',
      restartNote,
    );
  }

  remove(host) {
    if (!Object.hasOwn(this.proxyHosts, host)) {
      return error(
        'Host not found',
        `${colors.cyan(host)} isn't in the front-proxy config.`,
        `See the configured hosts with ${colors.cyan('front-proxy list')}`,
      );
    }

    const { [host]: _, ...newProxyHosts } = this.proxyHosts;

    this.saveProxyHosts(newProxyHosts);

    return success('Host removed', colors.cyan(host), '', restartNote);
  }

  list() {
    if (Object.keys(this.proxyHosts).length === 0) {
      return info(
        'No hosts configured',
        `Add one with ${colors.cyan('front-proxy add <host:port>')}`,
      );
    }

    return info('Hosts', '', ...hostRows(this.proxyHosts));
  }

  // Runs mkcert with its output captured, behind a spinner. Returns whether it worked.
  async createCert(name, domains) {
    const { cert, key } = this.getCertPaths(name);
    const certSpinner = spinner(`Creating cert for ${name}…`);

    try {
      await execFileAsync(this.mkcertPath, ['-cert-file', cert, '-key-file', key, ...domains]);
      certSpinner.succeed(`Cert created for ${name}`, colors.dim(cert));

      return true;
    } catch (err) {
      certSpinner.fail(
        `Couldn't create the cert for ${name}`,
        ...(err.stderr || err.message).trim().split('\n'),
      );
      process.exitCode = 1;

      return false;
    }
  }

  async generateCerts(target) {
    try {
      execFileSync(this.mkcertPath, ['-help'], { stdio: 'ignore' });
    } catch (err) {
      return error(
        'mkcert was not found in your PATH',
        `Install it with ${colors.cyan('brew install mkcert')} (macOS)`,
        `or follow ${colors.cyan('https://github.com/FiloSottile/mkcert#installation')}, then try again.`,
      );
    }

    const hosts =
      typeof target === 'string' ? [target] : Object.keys(this.proxyHosts);

    if (hosts.length === 0) {
      return error(
        'No hosts configured',
        `Pass a host, eq.: ${colors.cyan('front-proxy generate-certs myhost.local')}`,
      );
    }

    fs.mkdirSync(this.keysPath, { recursive: true });

    // Installs the local CA into the system trust store (no-op if already installed).
    // No spinner: it can ask for a password, and the spinner would hide the prompt.
    info('Checking the mkcert local CA');
    execFileSync(this.mkcertPath, ['-install'], { stdio: 'inherit' });
    console.log('');

    if (!this.readCert(defaultCertName)) {
      await this.createCert(defaultCertName, ['localhost', '127.0.0.1', '::1', adminHost]);
    }

    const proxyHosts = { ...this.proxyHosts };

    for (const host of hosts) {
      if (!(await this.createCert(host, [host]))) {
        continue;
      }

      if (Object.hasOwn(proxyHosts, host)) {
        proxyHosts[host] = { ...proxyHosts[host], cert: host };
      } else {
        warn(
          `${host} isn't in the proxy config yet`,
          `Add it with ${colors.cyan(`front-proxy add ${host}:<port>`)} and it will use this cert.`,
        );
      }
    }

    this.saveProxyHosts(proxyHosts);
  }
}

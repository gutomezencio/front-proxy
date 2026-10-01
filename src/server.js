import Hapi from '@hapi/hapi';
import h2o2 from '@hapi/h2o2';
import fs from 'fs';
import tls from 'tls';
import { execFileSync } from 'child_process';
import { dirname, resolve } from 'path';
import { getConfigDir } from './config-dir.js';

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

const restartNote =
  'It applies the next time the proxy starts (restart it if it is running).';

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
    this.proxyHosts = this.loadProxyHosts();
  }

  loadProxyHosts() {
    if (!fs.existsSync(this.proxyHostsPath)) {
      return {};
    }

    const config = JSON.parse(fs.readFileSync(this.proxyHostsPath, 'utf8'));

    return Object.keys(config)
      .filter((key) => !key.startsWith('$'))
      .reduce((hosts, key) => ({ ...hosts, [key]: config[key] }), {});
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

  readCert(name) {
    const { cert, key } = this.getCertPaths(name);

    if (!fs.existsSync(cert) || !fs.existsSync(key)) {
      return null;
    }

    return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
  }

  getSecureContexts() {
    const contexts = {};

    Object.keys(this.proxyHosts).forEach((host) => {
      const { cert: certName } = this.proxyHosts[host];

      if (!certName) {
        return;
      }

      const certFiles = this.readCert(certName);

      if (!certFiles) {
        console.warn(
          `Cert "${certName}" for ${host} not found in ${this.keysPath}. Using the default cert. Run "front-proxy generate-certs ${host}" to create it.`,
        );
        return;
      }

      contexts[host] = tls.createSecureContext(certFiles);
    });

    return contexts;
  }

  async start({ persistHosts = false } = {}) {
    this.persistHosts = persistHosts;
    stopSignals.forEach((signal) => process.on(signal, () => this.stop()));

    // Leftovers from a run that didn't stop cleanly, or from --persist-hosts.
    this.cleanHostsFile();

    try {
      await this.startServers();
      this.writeHostsFile();
    } catch (err) {
      console.error(`front-proxy couldn't start: ${err.message}`);
      this.persistHosts = false;
      process.exitCode = 1;

      return this.stop();
    }

    console.log(`Hosts added to ${this.hostFilePath}. Press Ctrl+C to stop.`);
  }

  async startServers() {
    const secureContexts = this.getSecureContexts();
    const defaultCert = this.readCert(defaultCertName);

    this.ServerHTTP = Hapi.server({
      port: 80,
    });
    await this.startServer(this.ServerHTTP);

    if (!defaultCert) {
      return console.warn(
        `No default cert found in ${this.keysPath}, so HTTPS (443) is disabled. Run "front-proxy generate-certs" to create it.`,
      );
    }

    // The default cert is used for hosts without their own "cert".
    this.tls = {
      ...defaultCert,
      SNICallback: (servername, cb) => cb(null, secureContexts[servername]),
    };

    this.ServerHTTPS = Hapi.server({
      port: 443,
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

  async stop() {
    if (this.stopping) {
      return;
    }

    this.stopping = true;

    // Synchronous and first, so /etc/hosts is clean even if stopping Hapi hangs.
    if (this.persistHosts) {
      console.log(`\nHosts kept in ${this.hostFilePath} (--persist-hosts).`);
    } else {
      try {
        this.cleanHostsFile();
        console.log(`\nHosts removed from ${this.hostFilePath}.`);
      } catch (err) {
        console.error(`\nCouldn't clean ${this.hostFilePath}: ${err.message}`);
      }
    }

    await Promise.allSettled(
      [this.ServerHTTP, this.ServerHTTPS]
        .filter(Boolean)
        .map((server) => server.stop({ timeout: 1000 })),
    );

    console.log('front-proxy stopped.');
    process.exit();
  }

  async startServer(server) {
    const { proxyHosts } = this;

    await server.register({ plugin: h2o2 });

    server.route({
      method: '*',
      path: '/{path*}',
      options: {
        handler(request, h) {
          const [host] = (request.headers.host || '').split(':');
          const target = proxyHosts[host];

          if (!target) {
            return h
              .response(`front-proxy: no proxy rule for host "${host}".`)
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

    const { settings } = server;

    let serverInfo = `in port ${settings.port}`;
    let tlsInfo = 'with HTTP';

    if (settings.tls) {
      tlsInfo = 'with HTTPS';
    }

    console.log(`Server running ${serverInfo} ${tlsInfo}`);
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

    const hosts = Object.keys(this.proxyHosts);

    if (hosts.length === 0) {
      return;
    }

    const content = this.getHostFileContent();
    const separator = content === '' || content.endsWith('\n') ? '\n' : '\n\n';

    fs.appendFileSync(this.hostFilePath, `${separator}${buildHostsBlock(hosts)}\n`);
  }

  add({ host, port }) {
    if (this.proxyHosts[host]) {
      return console.error(
        `The current host is already added. Provide another one.`,
      );
    }

    const { cert, key } = this.getCertPaths(host);
    const hasCert = fs.existsSync(cert) && fs.existsSync(key);

    this.saveProxyHosts({
      ...this.proxyHosts,
      [host]: hasCert ? { port, cert: host } : { port },
    });

    return console.log(
      `The host ${host}:${port} was successfully added to config. ${restartNote}`,
    );
  }

  remove(host) {
    if (!this.proxyHosts[host]) {
      return console.error(
        `Can't find the host "${host}" in the front-proxy config. Please, check the host name and try again.`,
      );
    }

    const { [host]: _, ...newProxyHosts } = this.proxyHosts;

    this.saveProxyHosts(newProxyHosts);

    return console.log(`The host ${host} was successfully removed. ${restartNote}`);
  }

  list() {
    const hostsArray = Object.keys(this.proxyHosts);

    if (hostsArray.length === 0) {
      return console.error(`Can't find any hosts configured.`);
    }

    hostsArray.forEach((item) => {
      const { port, cert } = this.proxyHosts[item];

      console.log(
        `HOST: ${item} | PORT: ${port}${cert ? ` | CERT: ${cert}` : ''}`,
      );
    });
  }

  generateCerts(target) {
    try {
      execFileSync('mkcert', ['-help'], { stdio: 'ignore' });
    } catch (err) {
      return console.error(
        `mkcert was not found in your PATH.\nInstall it with "brew install mkcert" (macOS) or follow https://github.com/FiloSottile/mkcert#installation, then try again.`,
      );
    }

    const hosts =
      typeof target === 'string' ? [target] : Object.keys(this.proxyHosts);

    if (hosts.length === 0) {
      return console.error(
        `Can't find any hosts configured. Pass a host, eq.: front-proxy generate-certs myhost.local`,
      );
    }

    fs.mkdirSync(this.keysPath, { recursive: true });

    // Installs the local CA into the system trust store (no-op if already installed).
    execFileSync('mkcert', ['-install'], { stdio: 'inherit' });

    if (!this.readCert(defaultCertName)) {
      const { cert, key } = this.getCertPaths(defaultCertName);

      execFileSync(
        'mkcert',
        ['-cert-file', cert, '-key-file', key, 'localhost', '127.0.0.1', '::1'],
        { stdio: 'inherit' },
      );
    }

    const proxyHosts = { ...this.proxyHosts };

    hosts.forEach((host) => {
      const { cert, key } = this.getCertPaths(host);

      execFileSync('mkcert', ['-cert-file', cert, '-key-file', key, host], {
        stdio: 'inherit',
      });

      if (proxyHosts[host]) {
        proxyHosts[host] = { ...proxyHosts[host], cert: host };
      } else {
        console.warn(
          `${host} is not in the proxy config yet. Add it with "front-proxy add ${host}:<port>" and set "cert": "${host}".`,
        );
      }
    });

    this.saveProxyHosts(proxyHosts);
  }
}

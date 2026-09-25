import Hapi from 'hapi';
import h2o2 from 'h2o2';
import fs from 'fs';
import tls from 'tls';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const hostsFileMarker = (host) => `# > ${host} < Host added by front-proxy`;

const defaultCertName = 'default';

// Written as the first key of config/proxyHosts.json; keys starting with "$" are not hosts.
const proxyHostsComment =
  'front-proxy hosts: { "<domain>": { "port": <local port>, "cert": "<name>" } }. Managed by --add / --remove / --generate-certs. "cert" is optional and points to keys/_private-<name>-{cert,key}.pem.';

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default class Server {
  constructor() {
    this.hostFilePath = resolve('/', 'etc/hosts');
    this.proxyHostsPath = resolve(__dirname, '../config/proxyHosts.json');
    this.keysPath = resolve(__dirname, '../keys');
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
          `Cert "${certName}" for ${host} not found in ${this.keysPath}. Using the default cert. Run "front-proxy --generate-certs ${host}" to create it.`,
        );
        return;
      }

      contexts[host] = tls.createSecureContext(certFiles);
    });

    return contexts;
  }

  start() {
    const secureContexts = this.getSecureContexts();
    const defaultCert = this.readCert(defaultCertName);

    this.ServerHTTP = new Hapi.server({
      port: 80,
    });
    this.startServer(this.ServerHTTP);

    if (!defaultCert) {
      return console.warn(
        `No default cert found in ${this.keysPath}, so HTTPS (443) is disabled. Run "front-proxy --generate-certs" to create it.`,
      );
    }

    // The default cert is used for hosts without their own "cert".
    this.tls = {
      ...defaultCert,
      SNICallback: (servername, cb) => cb(null, secureContexts[servername]),
    };

    this.ServerHTTPS = new Hapi.server({
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
    this.startServer(this.ServerHTTPS);
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

  checkAlreadyExist(host) {
    const hostLine = new RegExp(`^127\\.0\\.0\\.1\\s+${escapeRegExp(host)}\\s*$`, 'm');

    return hostLine.test(this.getHostFileContent());
  }

  add({ host, port }) {
    if (this.checkAlreadyExist(host) || this.proxyHosts[host]) {
      return console.error(
        `The current host is already added. Provide another one.`,
      );
    }

    fs.appendFileSync(
      this.hostFilePath,
      `\n${hostsFileMarker(host)}\n127.0.0.1 ${host}\n`,
    );

    const { cert, key } = this.getCertPaths(host);
    const hasCert = fs.existsSync(cert) && fs.existsSync(key);

    this.saveProxyHosts({
      ...this.proxyHosts,
      [host]: hasCert ? { port, cert: host } : { port },
    });

    return console.log(
      `The host ${host}:${port} was successfully added to config.`,
    );
  }

  remove(host) {
    if (!this.checkAlreadyExist(host) || !this.proxyHosts[host]) {
      return console.error(
        `Can't find the host "${host}" in your OS hosts file or in front-proxy config. Please, check the host name and try again.`,
      );
    }

    // Also matches entries written with \r\n by older versions.
    const hostBlock = new RegExp(
      `\\r?\\n${escapeRegExp(hostsFileMarker(host))}\\r?\\n127\\.0\\.0\\.1 ${escapeRegExp(host)}(\\r?\\n)?`,
    );

    fs.writeFileSync(
      this.hostFilePath,
      this.getHostFileContent().replace(hostBlock, ''),
    );

    const { [host]: _, ...newProxyHosts } = this.proxyHosts;

    this.saveProxyHosts(newProxyHosts);

    return console.log(`The host ${host} was successfully removed.`);
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
        `Can't find any hosts configured. Pass a host, eq.: --generate-certs myhost.local`,
      );
    }

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
          `${host} is not in the proxy config yet. Add it with "front-proxy --add ${host}:<port>" and set "cert": "${host}".`,
        );
      }
    });

    this.saveProxyHosts(proxyHosts);
  }
}

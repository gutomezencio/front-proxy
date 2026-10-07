import net from 'net';
import type Server from './server.js';
import { adminHost, type HostEntry, type ProxyHosts } from './hosts-validation.js';

// Changes to proxyHosts.json and the state the admin page and the MCP server show.
// Shared by the CLI, the admin API and the MCP tools, so they apply the same rules.
// Every change reads the file fresh, so edits made elsewhere in the meantime aren't lost.

export const maxHosts = 100;

export type CertStatus = 'own' | 'missing' | 'default';
export type DescribedEntry = HostEntry & { certStatus: CertStatus };
export type DescribedHosts = Record<string, DescribedEntry>;

export type ProxyState = {
  adminHost: string;
  https: boolean;
  active: DescribedHosts;
  config: DescribedHosts;
  pending: boolean;
};

export type ConfigChange =
  | { ok: true; config: ProxyHosts }
  | { ok: false; status: 400 | 404 | 409; error: string };

export type PortStatus = 'up' | 'down';

// Hosts must be normalized and valid: the callers validate them first.
export const addHost = (proxy: Server, host: string, port: number): ConfigChange => {
  const config = proxy.loadProxyHosts({ quiet: true });

  if (Object.hasOwn(config, host)) {
    return { ok: false, status: 409, error: `${host} is already added` };
  }

  if (Object.keys(config).length >= maxHosts) {
    return { ok: false, status: 400, error: `front-proxy supports up to ${maxHosts} hosts` };
  }

  const next = { ...config, [host]: proxy.hostEntry(host, port) };

  proxy.saveProxyHosts(next);

  return { ok: true, config: next };
};

export const setHostPort = (proxy: Server, host: string, port: number): ConfigChange => {
  const config = proxy.loadProxyHosts({ quiet: true });

  if (!Object.hasOwn(config, host)) {
    return { ok: false, status: 404, error: `${host} isn't configured` };
  }

  const next = { ...config, [host]: { ...config[host], port } };

  proxy.saveProxyHosts(next);

  return { ok: true, config: next };
};

export const removeHost = (proxy: Server, host: string): ConfigChange => {
  const config = proxy.loadProxyHosts({ quiet: true });

  if (!Object.hasOwn(config, host)) {
    return { ok: false, status: 404, error: `${host} isn't configured` };
  }

  const { [host]: _, ...next } = config;

  proxy.saveProxyHosts(next);

  return { ok: true, config: next };
};

// Same comparison the admin page uses to mark pending changes.
const sameHosts = (a: ProxyHosts, b: ProxyHosts) => {
  const keys = Object.keys(a);

  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (host) => Object.hasOwn(b, host) && a[host].port === b[host].port && a[host].cert === b[host].cert,
    )
  );
};

// Configured hosts with whether their cert files exist now.
export const describeConfig = (proxy: Server, hosts: ProxyHosts): DescribedHosts =>
  Object.fromEntries(
    Object.entries(hosts).map(([host, entry]) => [host, { ...entry, certStatus: proxy.certStatus(entry) }]),
  );

// For active hosts, 'own' means the running proxy loaded the cert (applyConfig() or start()),
// not just that its files exist now, e.g. right after `generate-certs` filled in missing files.
const describeActive = (proxy: Server, hosts: ProxyHosts): DescribedHosts =>
  Object.fromEntries(
    Object.entries(hosts).map(([host, entry]) => {
      let certStatus: CertStatus = 'default';

      if (entry.cert) {
        certStatus = proxy.secureContexts?.[host] ? 'own' : 'missing';
      }

      return [host, { ...entry, certStatus }];
    }),
  );

// What the running proxy serves (active) next to what's on disk (config).
export const getState = (proxy: Server): ProxyState => {
  const config = describeConfig(proxy, proxy.loadProxyHosts({ quiet: true }));
  const active = describeActive(proxy, proxy.activeHosts ?? {});
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

// Resolves to whether something accepts connections on 127.0.0.1:<port>.
export const isListening = (port: number) =>
  new Promise<boolean>((done) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (up: boolean) => {
      socket.destroy();
      done(up);
    };

    socket.setTimeout(300, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

// 'up' or 'down' for each host, depending on whether its app listens on its port.
export const hostStatuses = async (hosts: Record<string, { port: number }>): Promise<Record<string, PortStatus>> => {
  const entries = await Promise.all(
    Object.entries(hosts).map(async ([host, { port }]) => [host, (await isListening(port)) ? 'up' : 'down'] as const),
  );

  return Object.fromEntries(entries);
};

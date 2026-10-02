// Pure helpers for the admin page: no DOM and no fetch, so they're unit tested in Node.

// Mirrors src/hosts-validation.js. The server validates again; this only gives faster feedback.
const hostLabel = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const normalizeHost = (value) =>
  value.trim().toLowerCase().replace(/\.$/, '');

// Returns an error message, or null when the host is valid.
export const hostProblem = (host, adminHost) => {
  if (!host) return 'Enter a host, eq.: myapp.local';
  if (host.length > 253) return 'The host is longer than 253 characters';
  const labels = host.split('.');
  if (!labels.every((label) => hostLabel.test(label))) {
    return 'Use letters, digits, hyphens and dots, eq.: myapp.local';
  }
  if (/^\d+$/.test(labels[labels.length - 1]))
    return 'Use a hostname, not an IP address';
  if (host === 'localhost') return "localhost can't be proxied";
  if (adminHost && host === adminHost)
    return `${host} is reserved for this page`;
  return null;
};

// Returns an error message, or null when the port is valid.
export const portProblem = (value) => {
  const text = String(value).trim();
  const port = Number(text);
  if (!/^\d{1,5}$/.test(text) || port < 1 || port > 65535)
    return 'Use a port from 1 to 65535';
  if (port === 80 || port === 443)
    return `Port ${port} is used by front-proxy itself`;
  return null;
};

// Rows for every host in the config or active in the proxy, sorted, with what changed.
export const hostRows = ({ config, active }) => {
  const names = [
    ...new Set([...Object.keys(config), ...Object.keys(active)]),
  ].sort();

  return names.map((host) => {
    const configEntry = config[host];
    const activeEntry = active[host];
    let change = null;

    if (!activeEntry) change = 'added';
    else if (!configEntry) change = 'removed';
    else if (
      configEntry.port !== activeEntry.port ||
      configEntry.cert !== activeEntry.cert
    )
      change = 'changed';

    return {
      host,
      config: configEntry,
      active: activeEntry,
      change,
      entry: configEntry ?? activeEntry,
    };
  });
};

// Why HTTPS can't be opened for an active host, or null when it can. Without its own cert
// the proxy serves the default one (localhost), which browsers reject for this domain.
export const httpsProblem = ({ config, active }, httpsOn) => {
  if (!httpsOn) return 'HTTPS is off: generate certs and restart';
  if (active.certStatus === 'own') return null;
  if (config?.certStatus === 'own') return 'New cert saved: click Apply now';
  return 'Needs its own cert (see Certificate)';
};

// Hosts whose own cert the proxy serves in `after`, but didn't in `before`.
export const newCertHosts = (before, after) =>
  Object.keys(after.active).filter(
    (host) =>
      after.active[host].certStatus === 'own' &&
      before?.active[host]?.certStatus !== 'own',
  );

export const portStatusTitle = (status, port) => {
  if (status === 'up') return `Something is listening on port ${port}`;
  if (status === 'down') return `Nothing is listening on port ${port}`;
  return 'Checking…';
};

// Shared by the CLI, the admin page and loadProxyHosts. Hosts end up in /etc/hosts and
// cert names in file paths, so anything that doesn't pass here is never used.

export const adminHost = 'front-proxy.localhost';

// Ports the proxy binds itself; proxying to them would loop back into the proxy.
const reservedPorts = [80, 443];

const hostLabel = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const certName = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export const normalizeHost = (input) =>
  String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');

// Returns an error message, or null when the host is valid.
export const validateHost = (host) => {
  if (typeof host !== 'string' || host === '') {
    return 'The host is empty';
  }

  if (host.length > 253) {
    return 'The host is longer than 253 characters';
  }

  const labels = host.split('.');

  if (!labels.every((label) => hostLabel.test(label))) {
    return `"${host}" isn't a valid hostname: use letters, digits, hyphens and dots, eq.: myapp.local`;
  }

  if (/^\d+$/.test(labels[labels.length - 1])) {
    return `"${host}" looks like an IP address. Use a hostname, eq.: myapp.local`;
  }

  const lower = host.toLowerCase();

  if (lower === 'localhost') {
    return "localhost can't be proxied";
  }

  if (lower === adminHost) {
    return `${adminHost} is reserved for the front-proxy admin page`;
  }

  return null;
};

// Returns { port } or { error }. Accepts a number or a string of digits.
export const validatePort = (value) => {
  const text = String(value ?? '').trim();

  if (!/^\d{1,5}$/.test(text)) {
    return { error: `"${text}" isn't a valid port: use a number from 1 to 65535` };
  }

  const port = Number(text);

  if (port < 1 || port > 65535) {
    return { error: `${port} isn't a valid port: use a number from 1 to 65535` };
  }

  if (reservedPorts.includes(port)) {
    return { error: `Port ${port} is used by front-proxy itself` };
  }

  return { port };
};

// Cert names become keys/_private-<name>-{cert,key}.pem, so no slashes or "..".
export const validateCertName = (name) =>
  typeof name === 'string' && certName.test(name) && !name.includes('..')
    ? null
    : `"${name}" isn't a valid cert name: use letters, digits, dots, hyphens and underscores`;

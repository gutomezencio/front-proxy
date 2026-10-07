import { z } from 'zod';

// Shared by the CLI, the admin page, the MCP server and loadProxyHosts. Hosts end up in
// /etc/hosts and cert names in file paths, so anything that doesn't pass here is never used.
// The zod schemas are the source of truth; validateHost/validatePort/validateCertName wrap
// them for callers that only want the message.

export const adminHost = 'front-proxy.localhost';

// Ports the proxy binds itself; proxying to them would loop back into the proxy.
const reservedPorts = [80, 443];

const hostLabel = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const certName = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export const normalizeHost = (input: unknown): string =>
  String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');

// Returns an error message, or null when the host is valid.
const hostProblem = (host: string): string | null => {
  if (host === '') {
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

// Returns the port, or an error message.
const checkPort = (value: number | string): { port: number } | { error: string } => {
  const text = String(value).trim();

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

const certMessage = (name: unknown): string =>
  `"${name}" isn't a valid cert name: use letters, digits, dots, hyphens and underscores`;

// A host as it is stored: already normalized.
export const hostSchema = z.string().superRefine((host, ctx) => {
  const problem = hostProblem(host);

  if (problem) {
    ctx.addIssue({ code: 'custom', message: problem });
  }
});

// A host as people type it ("  My.App.local. "), normalized before it's checked.
export const hostInputSchema = z
  .string()
  .transform(normalizeHost)
  .pipe(hostSchema)
  .describe('Hostname to map, eq.: myapp.local (letters, digits, hyphens and dots)');

// A number or a string of digits, eq.: 3000 or "3000".
export const portSchema = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const result = checkPort(value);

    if ('error' in result) {
      ctx.addIssue({ code: 'custom', message: result.error });

      return z.NEVER;
    }

    return result.port;
  })
  .describe('Local port the app listens on, 1-65535 (not 80 or 443)');

// Cert names become keys/_private-<name>-{cert,key}.pem, so no slashes or "..".
export const certNameSchema = z.string().superRefine((name, ctx) => {
  if (!certName.test(name) || name.includes('..')) {
    ctx.addIssue({ code: 'custom', message: certMessage(name) });
  }
});

// One entry of proxyHosts.json. Unknown fields are dropped.
export const hostEntrySchema = z.object({
  port: portSchema,
  cert: certNameSchema.optional(),
});

export type HostEntry = z.output<typeof hostEntrySchema>;
export type ProxyHosts = Record<string, HostEntry>;

const firstMessage = (error: z.ZodError): string => error.issues[0].message;

// Returns an error message, or null when the host is valid.
export const validateHost = (host: unknown): string | null => {
  if (typeof host !== 'string') {
    return 'The host is empty';
  }

  const result = hostSchema.safeParse(host);

  return result.success ? null : firstMessage(result.error);
};

// Returns { port } or { error }. Accepts a number or a string of digits.
export const validatePort = (value: unknown): { port: number; error?: undefined } | { port?: undefined; error: string } => {
  const result = portSchema.safeParse(typeof value === 'number' ? value : String(value ?? ''));

  return result.success ? { port: result.data } : { error: firstMessage(result.error) };
};

export const validateCertName = (name: unknown): string | null =>
  certNameSchema.safeParse(name).success ? null : certMessage(name);

// Returns why a proxyHosts.json entry can't be used, or null.
export const hostEntryProblem = (host: string, entry: unknown): string | null => {
  const hostError = validateHost(host);

  if (hostError) {
    return hostError;
  }

  const { port, cert } = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;

  return validatePort(port).error ?? (cert === undefined ? null : validateCertName(cert));
};

// Parses a JSON request body against an object schema. Missing and unknown fields get their
// own messages, so API clients learn the shape; field values are then checked by the schema.
export const parseBody = <Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
  payload: unknown,
): { body: z.output<z.ZodObject<Shape>>; error?: undefined } | { body?: undefined; error: string } => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'Send a JSON object' };
  }

  const fields = Object.keys(schema.shape);
  const given = payload as Record<string, unknown>;
  const unknown = Object.keys(given).filter((key) => !fields.includes(key));

  if (unknown.length) {
    return { error: `Unknown fields: ${unknown.join(', ')}` };
  }

  const missing = fields.filter((field) => given[field] === undefined);

  if (missing.length) {
    return { error: `Missing fields: ${missing.join(', ')}` };
  }

  const result = schema.safeParse(given);

  return result.success ? { body: result.data } : { error: firstMessage(result.error) };
};

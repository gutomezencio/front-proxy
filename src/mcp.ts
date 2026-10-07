import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import { resolve } from 'path';
import { createAdminClient, type AdminClient } from './admin-client.js';
import { addHost, describeConfig, hostStatuses, removeHost, setHostPort, type ConfigChange } from './hosts-config.js';
import { adminHost, hostInputSchema, portSchema } from './hosts-validation.js';
import { info, useStderr } from './output.js';
import type Server from './server.js';

// `front-proxy mcp`: an MCP server on stdio, so code assistants can manage the proxy.
// It runs as the user, like add/remove/generate-certs: it edits proxyHosts.json and creates
// certs, and asks a running proxy to apply them through its admin API. It can't start or
// stop the proxy (that needs sudo and a password prompt).

const { version } = JSON.parse(
  fs.readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as { version: string };

const instructions = `front-proxy maps local domains (eq. myapp.local) to apps on local ports, through a reverse proxy on ports 80/443 and /etc/hosts entries.
- add_host, update_host and remove_host change the saved config. Changes reach the running proxy once you call apply_config.
- generate_certs creates trusted HTTPS certs with mkcert for one host or all of them; call apply_config afterwards.
- proxy_status says whether the proxy runs and whether each app listens on its port.
- Starting or stopping the proxy needs sudo: ask the user to run \`front-proxy\` in a terminal.`;

const reply = (text: string, data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(data, null, 2)}` }],
  structuredContent: data,
});

const failure = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

export const createMcpServer = (proxy: Server, { adminClient = createAdminClient() }: { adminClient?: AdminClient } = {}) => {
  const server = new McpServer({ name: 'front-proxy', version }, { instructions });

  // What a config change needs before the proxy serves it.
  const nextStep = async () => {
    const reach = await adminClient.reach();

    if (!reach.running) {
      return 'front-proxy is not running: the change is used when the user starts it with `front-proxy`.';
    }

    if (!reach.admin) {
      return `The running proxy can't be updated from here (${reach.problem}).`;
    }

    return 'Call apply_config to make it active in the running proxy.';
  };

  const afterChange = async (change: ConfigChange, text: string, data: Record<string, unknown>) =>
    change.ok ? reply(`${text} ${await nextStep()}`, data) : failure(change.error);

  server.registerTool(
    'list_hosts',
    {
      title: 'List hosts',
      description: 'List the configured domains with their local port and HTTPS cert status ("own", "missing" or "default").',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const config = describeConfig(proxy, proxy.loadProxyHosts({ quiet: true }));
      const lines = Object.entries(config).map(
        ([host, { port, certStatus }]) => `${host} → 127.0.0.1:${port} (cert: ${certStatus})`,
      );

      return reply(lines.length ? lines.join('\n') : 'No hosts configured. Add one with add_host.', { hosts: config });
    },
  );

  server.registerTool(
    'add_host',
    {
      title: 'Add host',
      description: 'Map a local domain to an app on a local port, eq. myapp.local → 3000. Saved to the config; call apply_config to use it in the running proxy.',
      inputSchema: { host: hostInputSchema, port: portSchema },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ host, port }) => {
      const change = addHost(proxy, host, port);

      return afterChange(change, `Added ${host} → 127.0.0.1:${port}.`, { host, port });
    },
  );

  server.registerTool(
    'update_host',
    {
      title: 'Change a host port',
      description: 'Point a configured domain to another local port. Call apply_config to use it in the running proxy.',
      inputSchema: { host: hostInputSchema, port: portSchema },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ host, port }) => {
      const change = setHostPort(proxy, host, port);

      return afterChange(change, `${host} now points to 127.0.0.1:${port}.`, { host, port });
    },
  );

  server.registerTool(
    'remove_host',
    {
      title: 'Remove host',
      description: 'Remove a domain from the config. Call apply_config to remove it from the running proxy and /etc/hosts.',
      inputSchema: { host: hostInputSchema },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ host }) => {
      const change = removeHost(proxy, host);

      return afterChange(change, `Removed ${host}.`, { host });
    },
  );

  server.registerTool(
    'generate_certs',
    {
      title: 'Generate HTTPS certs',
      description: 'Create locally trusted HTTPS certs with mkcert for one domain, or for every configured domain when none is given. Needs mkcert installed, with its local CA installed once (`mkcert -install`).',
      inputSchema: { host: hostInputSchema.optional() },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ host }) => {
      const result = await proxy.generateCerts(host ?? true, { interactive: false });

      if (!result.ok) {
        return failure(result.error);
      }

      const { created, failed, notConfigured } = result;
      const lines = [
        ...(created.length ? [`Created certs for: ${created.join(', ')}.`] : []),
        ...failed.map(({ name, error }) => `Couldn't create the cert for ${name}: ${error}`),
        ...(notConfigured.length ? [`Not in the config yet (add them to use the certs): ${notConfigured.join(', ')}.`] : []),
      ];
      const data = { created, failed, notConfigured };

      if (!created.length) {
        return { ...reply(lines.join('\n'), data), isError: true };
      }

      return reply(`${lines.join('\n')}\n${await nextStep()}`, data);
    },
  );

  server.registerTool(
    'proxy_status',
    {
      title: 'Proxy status',
      description: 'Whether front-proxy is running, whether HTTPS is on, whether saved changes are waiting for apply_config, and whether each app listens on its port ("up"/"down").',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const config = proxy.loadProxyHosts({ quiet: true });
      const reach = await adminClient.reach();
      const active = reach.running && reach.admin ? reach.state.active : {};
      const ports = await hostStatuses({ ...active, ...config });
      const portLines = Object.entries(ports).map(([host, status]) => `${host}: ${status}`);

      if (!reach.running) {
        return reply(['front-proxy is not running. Ask the user to start it with `front-proxy` (it needs sudo).', ...portLines].join('\n'), {
          running: false,
          ports,
        });
      }

      if (!reach.admin) {
        return reply([`front-proxy is running, but its admin API isn't reachable: ${reach.problem}`, ...portLines].join('\n'), {
          running: true,
          admin: false,
          ports,
        });
      }

      const { https, pending } = reach.state;

      return reply(
        [
          `front-proxy is running (HTTPS ${https ? 'on' : 'off'}, admin page at http://${adminHost}).`,
          pending ? 'Saved changes are waiting: call apply_config.' : 'The running proxy uses the saved config.',
          ...portLines,
        ].join('\n'),
        { running: true, admin: true, https, pending, active, ports },
      );
    },
  );

  server.registerTool(
    'apply_config',
    {
      title: 'Apply the config',
      description: 'Load the saved config into the running proxy: routes, HTTPS certs and the /etc/hosts block, without restarting it. Needs the proxy running with its admin page (the default).',
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const { httpsNeedsRestart, active, https } = await adminClient.apply();
      const hosts = Object.keys(active);
      const lines = [
        `Config applied. Active hosts: ${hosts.length ? hosts.join(', ') : 'none'}.`,
        ...(httpsNeedsRestart ? ['HTTPS turns on after the user restarts front-proxy (the default cert was just created).'] : []),
      ];

      return reply(lines.join('\n'), { active, https, httpsNeedsRestart });
    },
  );

  return server;
};

// Logs go to stderr: stdout carries the JSON-RPC messages.
export const startMcpServer = async (proxy: Server, transport: Transport = new StdioServerTransport()) => {
  useStderr();
  await createMcpServer(proxy).connect(transport);
  info('front-proxy MCP server is running', 'Waiting for an MCP client on stdio.');
};

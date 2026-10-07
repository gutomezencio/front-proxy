// Builds front-proxy.mcpb, the one-click MCP Bundle for Claude Desktop: the compiled dist/,
// production node_modules and a manifest.json generated from package.json. The tool list comes
// from the real MCP server, so the manifest can't drift from it.
// Run after `npm run build` (npm run build:mcpb does both). publish.yml attaches the bundle
// to each GitHub release.
import { execFileSync } from 'child_process';
import fs from 'fs';
import { resolve } from 'path';

const root = resolve(import.meta.dirname, '..');
const stage = resolve(root, 'mcpb');
const output = resolve(root, 'front-proxy.mcpb');
const pkg = JSON.parse(fs.readFileSync(resolve(root, 'package.json'), 'utf8'));
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });

// The tools as the server registers them, read through an in-memory MCP client.
const listTools = async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createMcpServer } = await import(resolve(root, 'dist', 'mcp.js'));
  const { default: Server } = await import(resolve(root, 'dist', 'server.js'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'build-mcpb', version: pkg.version });

  await createMcpServer(new Server()).connect(serverTransport);
  await client.connect(clientTransport);

  const { tools } = await client.listTools();

  await client.close();

  return tools.map(({ name, description }) => ({ name, description }));
};

fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(output, { force: true });
fs.mkdirSync(stage);

fs.cpSync(resolve(root, 'dist'), resolve(stage, 'dist'), { recursive: true });
fs.copyFileSync(resolve(root, 'LICENSE'), resolve(stage, 'LICENSE'));
fs.copyFileSync(resolve(root, 'assets', 'icon.png'), resolve(stage, 'icon.png'));
fs.copyFileSync(resolve(root, 'package-lock.json'), resolve(stage, 'package-lock.json'));

// No scripts: prepack would try to build again from src/, which isn't staged.
const { scripts, devDependencies, ...runtimePkg } = pkg;

fs.writeFileSync(resolve(stage, 'package.json'), `${JSON.stringify(runtimePkg, null, 2)}\n`);
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage });

const manifest = {
  manifest_version: '0.3',
  name: pkg.name,
  display_name: 'front-proxy',
  version: pkg.version,
  description: 'Map local domains (and HTTPS) to apps on local ports, OS-wide.',
  long_description: `${pkg.description} The proxy itself runs with \`front-proxy\` in a terminal (it needs sudo); this bundle lets Claude add, change and remove domains, create HTTPS certs and apply the changes to the running proxy.`,
  author: { name: pkg.author.name, email: pkg.author.email, url: 'https://github.com/gutomezencio' },
  repository: { type: 'git', url: 'https://github.com/gutomezencio/front-proxy.git' },
  homepage: pkg.homepage,
  documentation: 'https://github.com/gutomezencio/front-proxy#mcp-server',
  support: pkg.bugs.url,
  icon: 'icon.png',
  license: pkg.license,
  keywords: pkg.keywords,
  server: {
    type: 'node',
    entry_point: 'dist/proxy-server.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/dist/proxy-server.js', 'mcp'],
    },
  },
  tools: await listTools(),
  compatibility: {
    platforms: pkg.os,
    runtimes: { node: pkg.engines.node },
  },
};

fs.writeFileSync(resolve(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const mcpb = resolve(root, 'node_modules', '.bin', 'mcpb');

run(mcpb, ['validate', resolve(stage, 'manifest.json')]);
run(mcpb, ['pack', stage, output]);

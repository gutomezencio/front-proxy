// Copies package.json's version into the files that carry it for agents and registries:
// server.json (MCP Registry), the Claude Code plugin manifest and its pinned `npx front-proxy@<version>`.
// prepare-release.yml runs it after `npm version`; test/release-metadata.test.ts checks the result.
import fs from 'fs';
import { resolve } from 'path';

const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(fs.readFileSync(resolve(root, 'package.json'), 'utf8'));

const update = (path, change) => {
  const file = resolve(root, path);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));

  change(json);
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
};

update('server.json', (server) => {
  server.version = version;
  server.packages.forEach((pkg) => {
    pkg.version = version;
  });
});

update('plugins/front-proxy/.claude-plugin/plugin.json', (plugin) => {
  plugin.version = version;
});

update('plugins/front-proxy/.mcp.json', ({ mcpServers }) => {
  const { args } = mcpServers['front-proxy'];
  const index = args.findIndex((arg) => /^front-proxy(@|$)/.test(arg));

  args[index] = `front-proxy@${version}`;
});

console.log(`Synced version ${version}`);

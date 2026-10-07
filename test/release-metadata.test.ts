import fs from 'fs'
import { join } from 'path'

// The files that list front-proxy for agents and registries must agree with package.json.
// scripts/sync-version.js keeps the versions in step; this catches anything it missed.

const root = join(import.meta.dirname, '..')
const read = (path) => fs.readFileSync(join(root, path), 'utf8')
const json = (path) => JSON.parse(read(path))

const pkg = json('package.json')
const server = json('server.json')
const marketplace = json('.claude-plugin/marketplace.json')
const plugin = json('plugins/front-proxy/.claude-plugin/plugin.json')
const pluginMcp = json('plugins/front-proxy/.mcp.json').mcpServers['front-proxy']
const readme = read('README.md')

// What every install path runs, without the version pin.
const mcpCommand = ['npx', '-y', 'front-proxy', 'mcp']
const unpinned = ({ command, args }) => [command, ...args.map((arg) => arg.replace(/^front-proxy@.*$/, 'front-proxy'))]

describe('release metadata', () => {
  it('lists the npm package in the MCP Registry under its mcpName', () => {
    expect(server.name).toBe(pkg.mcpName)
    expect(server.version).toBe(pkg.version)
    expect(server.description.length).toBeLessThanOrEqual(100)
    expect(server.packages).toEqual([
      expect.objectContaining({
        registryType: 'npm',
        identifier: pkg.name,
        version: pkg.version,
        transport: { type: 'stdio' },
        packageArguments: [{ type: 'positional', value: 'mcp' }],
      }),
    ])
  })

  it('ships a Claude Code plugin that runs the same version of the MCP server', () => {
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: plugin.name, source: './plugins/front-proxy' }),
    ])
    expect(plugin.version).toBe(pkg.version)
    expect(pluginMcp.args).toContain(`front-proxy@${pkg.version}`)
    expect(unpinned(pluginMcp)).toEqual(mcpCommand)
  })

  it('gives the plugin skill a name and a description that says when to use it', () => {
    const skill = read('plugins/front-proxy/skills/front-proxy/SKILL.md')
    const [, frontmatter] = skill.match(/^---\n([\s\S]*?)\n---\n/)!

    expect(frontmatter).toMatch(/^name: front-proxy$/m)
    expect(frontmatter).toMatch(/^description: .*Use when/m)
  })

  it('has README install links that run the same command', () => {
    const [, cursorConfig] = readme.match(/cursor\.com\/install-mcp\?name=front-proxy&config=([A-Za-z0-9+/=%]+)\)/)!
    const [, vscodeUrl] = readme.match(/vscode\.dev\/redirect\?url=([^)]+)\)/)!
    const vscodeConfig = decodeURIComponent(decodeURIComponent(vscodeUrl)).replace(/^vscode:mcp\/install\?/, '')

    expect(unpinned(JSON.parse(Buffer.from(decodeURIComponent(cursorConfig), 'base64').toString('utf8')))).toEqual(mcpCommand)
    expect(JSON.parse(vscodeConfig)).toMatchObject({ name: 'front-proxy' })
    expect(unpinned(JSON.parse(vscodeConfig))).toEqual(mcpCommand)
    expect(readme).toContain('releases/latest/download/front-proxy.mcpb')
  })
})

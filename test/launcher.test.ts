import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { childCommand, commandArgs, prepareConfigDir, requiresSudo } from '../src/launcher.js'

describe('launcher', () => {
  it('only the start command needs sudo', () => {
    expect(requiresSudo({ command: 'start' })).toBe(true)
    expect(requiresSudo({ command: 'list' })).toBe(false)
    expect(requiresSudo({ command: 'mcp' })).toBe(false)
  })

  it('rebuilds the arguments for proxy-server.js', () => {
    expect(commandArgs({ command: 'start', persistHosts: false, admin: true })).toEqual([])
    expect(commandArgs({ command: 'start', persistHosts: true, admin: false })).toEqual(['--persist-hosts', '--no-admin'])
    expect(commandArgs({ command: 'add', value: 'my.local:3000' })).toEqual(['add', 'my.local:3000'])
    expect(commandArgs({ command: 'generate-certs' })).toEqual(['generate-certs'])
    expect(commandArgs({ command: 'mcp' })).toEqual(['mcp'])
  })

  it('runs start under sudo with the config dir, and the rest as the user', () => {
    const [sudo, sudoArgs] = childCommand({ command: 'start', admin: true }, '/home/me/.front-proxy', '/bin/node')
    const [node, nodeArgs] = childCommand({ command: 'list' }, '/home/me/.front-proxy', '/bin/node')

    expect(sudo).toBe('sudo')
    expect(sudoArgs.slice(0, 3)).toEqual(['env', 'FRONT_PROXY_HOME=/home/me/.front-proxy', '/bin/node'])
    expect(sudoArgs[3]).toMatch(/src\/proxy-server\.js$/)
    expect(node).toBe('/bin/node')
    expect(nodeArgs.slice(1)).toEqual(['list'])
  })

  it('creates the config dir and an empty config, keeping an existing one', () => {
    const dir = join(fs.mkdtempSync(join(os.tmpdir(), 'front-proxy-')), 'config')

    try {
      prepareConfigDir(dir)

      expect(fs.existsSync(join(dir, 'keys'))).toBe(true)
      expect(fs.readFileSync(join(dir, 'proxyHosts.json'), 'utf8')).toBe('{}\n')

      fs.writeFileSync(join(dir, 'proxyHosts.json'), '{"a.local":{"port":1}}')
      prepareConfigDir(dir)

      expect(fs.readFileSync(join(dir, 'proxyHosts.json'), 'utf8')).toBe('{"a.local":{"port":1}}')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

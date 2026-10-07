import { jest } from '@jest/globals'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import fs from 'fs'
import http from 'http'
import os from 'os'
import { join } from 'path'
import { noAdmin } from '../src/admin-client.js'
import { createMcpServer, startMcpServer } from '../src/mcp.js'
import { useStderr } from '../src/output.js'
import Server from '../src/server.js'
import { failFakeMkcert, writeFakeMkcert } from './helpers/fake-mkcert.js'

const pkg = JSON.parse(fs.readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))

const state = (overrides = {}) => ({
  adminHost: 'front-proxy.localhost',
  https: true,
  pending: false,
  active: {},
  config: {},
  ...overrides,
})

// The admin client the MCP server would use to reach a running proxy.
const fakeAdminClient = () => ({
  reach: jest.fn(async () => ({ running: false })),
  apply: jest.fn(async () => ({ ...state(), httpsNeedsRestart: false })),
})

describe('MCP server', () => {
  let dir
  let bin
  let server
  let adminClient
  let client

  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })

    return { ...result, text: result.content.map(({ text }) => text).join('\n') }
  }

  const readConfig = () => JSON.parse(fs.readFileSync(server.proxyHostsPath, 'utf8'))

  beforeEach(async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'front-proxy-'))
    bin = fs.mkdtempSync(join(os.tmpdir(), 'front-proxy-bin-'))
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})

    server = new Server()
    server.hostFilePath = join(dir, 'hosts')
    server.proxyHostsPath = join(dir, 'proxyHosts.json')
    server.keysPath = dir
    server.mkcertPath = writeFakeMkcert(bin)
    server.saveProxyHosts({})
    adminClient = fakeAdminClient()

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    client = new Client({ name: 'test', version: '1.0.0' })
    await createMcpServer(server, { adminClient }).connect(serverTransport)
    await client.connect(clientTransport)
  })

  afterEach(async () => {
    await client.close()
    jest.restoreAllMocks()
    process.exitCode = undefined
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(bin, { recursive: true, force: true })
  })

  it('describes itself and its tools', async () => {
    const { tools } = await client.listTools()
    const addHost = tools.find(({ name }) => name === 'add_host')

    expect(client.getServerVersion()).toEqual({ name: 'front-proxy', version: pkg.version })
    expect(client.getInstructions()).toContain('apply_config')
    expect(tools.map(({ name }) => name)).toEqual([
      'list_hosts',
      'add_host',
      'update_host',
      'remove_host',
      'generate_certs',
      'proxy_status',
      'apply_config',
    ])
    expect(addHost.inputSchema.required).toEqual(['host', 'port'])
    expect(tools.find(({ name }) => name === 'list_hosts').annotations.readOnlyHint).toBe(true)
    expect(tools.find(({ name }) => name === 'remove_host').annotations.destructiveHint).toBe(true)
  })

  it('lists the configured hosts with their cert status', async () => {
    expect((await call('list_hosts')).text).toContain('No hosts configured')

    server.saveProxyHosts({ 'my.local': { port: 3000 }, 'api.local': { port: 4000, cert: 'api.local' } })

    const { text, structuredContent } = await call('list_hosts')

    expect(text).toContain('my.local → 127.0.0.1:3000 (cert: default)')
    expect(structuredContent).toEqual({
      hosts: {
        'my.local': { port: 3000, certStatus: 'default' },
        'api.local': { port: 4000, cert: 'api.local', certStatus: 'missing' },
      },
    })
  })

  it('adds a host and says how to apply it, whether the proxy runs or not', async () => {
    const added = await call('add_host', { host: ' My.Local. ', port: '3000' })

    expect(added.isError).toBeFalsy()
    expect(added.structuredContent).toEqual({ host: 'my.local', port: 3000 })
    expect(added.text).toContain('front-proxy is not running')
    expect(readConfig()['my.local']).toEqual({ port: 3000 })

    adminClient.reach.mockResolvedValue({ running: true, admin: true, state: state() })
    expect((await call('add_host', { host: 'api.local', port: 4000 })).text).toContain('Call apply_config')

    adminClient.reach.mockResolvedValue({ running: true, admin: false, problem: noAdmin })
    expect((await call('add_host', { host: 'web.local', port: 5000 })).text).toContain("can't be updated from here")
  })

  it('rejects invalid and duplicate hosts without saving them', async () => {
    server.saveProxyHosts({ 'my.local': { port: 3000 } })

    const invalid = await call('add_host', { host: 'my.local\n1.2.3.4 evil.com', port: 4000 })
    const reserved = await call('add_host', { host: 'other.local', port: 443 })
    const duplicate = await call('add_host', { host: 'my.local', port: 4000 })

    expect(invalid.isError).toBe(true)
    expect(invalid.text).toContain("isn't a valid hostname")
    expect(reserved.isError).toBe(true)
    expect(reserved.text).toContain('Port 443 is used by front-proxy itself')
    expect(duplicate.isError).toBe(true)
    expect(duplicate.text).toContain('my.local is already added')
    expect(Object.keys(readConfig())).toEqual(['$comment', 'my.local'])
  })

  it('changes the port of a host and removes hosts', async () => {
    server.saveProxyHosts({ 'my.local': { port: 3000 } })

    const updated = await call('update_host', { host: 'my.local', port: 4000 })

    expect(updated.text).toContain('my.local now points to 127.0.0.1:4000')
    expect(readConfig()['my.local']).toEqual({ port: 4000 })

    const missing = await call('update_host', { host: 'missing.local', port: 4000 })

    expect(missing.isError).toBe(true)
    expect(missing.text).toContain("missing.local isn't configured")

    expect((await call('remove_host', { host: 'MY.LOCAL' })).text).toContain('Removed my.local.')
    expect(readConfig()['my.local']).toBeUndefined()
    expect((await call('remove_host', { host: 'my.local' })).isError).toBe(true)
  })

  it('generates certs with mkcert and sets them in the config', async () => {
    server.saveProxyHosts({ 'my.local': { port: 3000 } })

    const all = await call('generate_certs')

    expect(all.isError).toBeFalsy()
    expect(all.structuredContent).toEqual({ created: ['default', 'my.local'], failed: [], notConfigured: [] })
    expect(all.text).toContain('Created certs for: default, my.local.')
    expect(readConfig()['my.local']).toEqual({ port: 3000, cert: 'my.local' })

    const one = await call('generate_certs', { host: 'New.Local' })

    expect(one.structuredContent).toEqual({ created: ['new.local'], failed: [], notConfigured: ['new.local'] })
    expect(one.text).toContain('Not in the config yet')
  })

  it('reports certs that could not be created', async () => {
    server.saveProxyHosts({ 'fail.local': { port: 3000 } })
    fs.writeFileSync(join(dir, '_private-default-cert.pem'), 'cert')
    fs.writeFileSync(join(dir, '_private-default-key.pem'), 'key')

    const failed = await call('generate_certs')

    expect(failed.isError).toBe(true)
    expect(failed.text).toContain("Couldn't create the cert for fail.local: mkcert: boom")
  })

  it('reports why mkcert could not run', async () => {
    expect((await call('generate_certs')).text).toContain('No hosts configured')

    failFakeMkcert(bin, 'install')

    const install = await call('generate_certs', { host: 'my.local' })

    expect(install.isError).toBe(true)
    expect(install.text).toContain('mkcert -install')
  })

  it('reports the proxy status and which apps are listening', async () => {
    const app = http.createServer()
    await new Promise<void>((done) => app.listen(0, '127.0.0.1', done))
    const { port } = app.address() as { port: number }

    try {
      server.saveProxyHosts({ 'up.local': { port } })

      const stopped = await call('proxy_status')

      expect(stopped.text).toContain('front-proxy is not running')
      expect(stopped.structuredContent).toEqual({ running: false, ports: { 'up.local': 'up' } })

      adminClient.reach.mockResolvedValue({ running: true, admin: false, problem: noAdmin })
      expect((await call('proxy_status')).structuredContent).toMatchObject({ running: true, admin: false })

      const active = { 'old.local': { port: 1, certStatus: 'default' } }

      adminClient.reach.mockResolvedValue({ running: true, admin: true, state: state({ pending: true, active }) })

      const running = await call('proxy_status')

      expect(running.text).toContain('front-proxy is running (HTTPS on')
      expect(running.text).toContain('call apply_config')
      expect(running.structuredContent).toEqual({
        running: true,
        admin: true,
        https: true,
        pending: true,
        active,
        ports: { 'old.local': 'down', 'up.local': 'up' },
      })

      adminClient.reach.mockResolvedValue({ running: true, admin: true, state: state({ https: false }) })

      const applied = await call('proxy_status')

      expect(applied.text).toContain('HTTPS off')
      expect(applied.text).toContain('uses the saved config')
    } finally {
      await new Promise<void>((done) => app.close(() => done()))
    }
  })

  it('applies the config to the running proxy', async () => {
    const active = { 'my.local': { port: 3000, certStatus: 'default' } }

    adminClient.apply.mockResolvedValue({ ...state({ active }), httpsNeedsRestart: false })

    const applied = await call('apply_config')

    expect(applied.text).toContain('Config applied. Active hosts: my.local.')
    expect(applied.structuredContent).toEqual({ active, https: true, httpsNeedsRestart: false })

    adminClient.apply.mockResolvedValue({ ...state({ https: false }), httpsNeedsRestart: true })

    const restart = await call('apply_config')

    expect(restart.text).toContain('Active hosts: none.')
    expect(restart.text).toContain('HTTPS turns on after the user restarts front-proxy')

    adminClient.apply.mockRejectedValue(new Error(noAdmin))

    const failed = await call('apply_config')

    expect(failed.isError).toBe(true)
    expect(failed.text).toContain('--no-admin')
  })
})

describe('startMcpServer', () => {
  afterEach(() => {
    useStderr(false)
    jest.restoreAllMocks()
  })

  it('connects to the transport and logs to stderr only', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1.0.0' })

    await startMcpServer(new Server(), serverTransport)
    await client.connect(clientTransport)

    expect((await client.listTools()).tools).toHaveLength(7)
    expect(error.mock.calls[0][0]).toContain('front-proxy MCP server is running')
    expect(log).not.toHaveBeenCalled()

    await client.close()
  })
})

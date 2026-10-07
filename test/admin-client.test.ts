import { jest } from '@jest/globals'
import fs from 'fs'
import http from 'http'
import os from 'os'
import { join } from 'path'
import Hapi from '@hapi/hapi'
import { createAdminClient, noAdmin, notRunning } from '../src/admin-client.js'
import { adminHost } from '../src/hosts-validation.js'
import Server from '../src/server.js'

// The client against a real proxy (admin page on or off) on a random port, and against
// fake servers for the failures a real proxy doesn't produce.

const listen = async (server: http.Server | Hapi.Server) => {
  if (server instanceof http.Server) {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))

    return (server.address() as { port: number }).port
  }

  return server.info.port as number
}

// A port nothing listens on.
const closedPort = async () => {
  const server = http.createServer()
  const port = await listen(server)

  await new Promise<void>((done) => server.close(() => done()))

  return port
}

describe('admin client', () => {
  let dir
  let proxy
  let hapiServer

  const startProxy = async ({ admin = true } = {}) => {
    proxy = new Server()
    proxy.hostFilePath = join(dir, 'hosts')
    proxy.proxyHostsPath = join(dir, 'proxyHosts.json')
    proxy.keysPath = dir
    proxy.adminEnabled = admin
    fs.writeFileSync(proxy.hostFilePath, '127.0.0.1 localhost\n')
    proxy.saveProxyHosts({ 'my.local': { port: 3000 } })

    hapiServer = Hapi.server({ port: 0, host: '127.0.0.1' })
    await proxy.startServer(hapiServer)

    return createAdminClient({ port: hapiServer.info.port })
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'front-proxy-'))
    hapiServer = null
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    await hapiServer?.stop()
    jest.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads the state of a running proxy', async () => {
    const client = await startProxy()

    const reach = await client.reach()

    expect(reach).toMatchObject({ running: true, admin: true })
    expect(reach.running && reach.admin && reach.state.config['my.local']).toEqual({ port: 3000, certStatus: 'default' })
  })

  it('applies the saved config with the page token', async () => {
    const client = await startProxy()

    proxy.saveProxyHosts({ 'my.local': { port: 3000 }, 'new.local': { port: 4000 } })

    const result = await client.apply()

    expect(result.pending).toBe(false)
    expect(result.httpsNeedsRestart).toBe(false)
    expect(Object.keys(result.active)).toEqual(['my.local', 'new.local'])
    expect(fs.readFileSync(proxy.hostFilePath, 'utf8')).toContain('127.0.0.1 new.local')
  })

  it('passes on the error when the proxy cannot apply the config', async () => {
    const client = await startProxy()

    proxy.hostFilePath = join(dir, 'missing', 'hosts')

    await expect(client.apply()).rejects.toThrow("Couldn't apply the config")
  })

  it('says when the proxy runs without its admin page', async () => {
    const client = await startProxy({ admin: false })

    expect(await client.reach()).toEqual({ running: true, admin: false, problem: noAdmin })
    await expect(client.apply()).rejects.toThrow(noAdmin)
  })

  it('says when the proxy is not running', async () => {
    const client = createAdminClient({ port: await closedPort() })

    expect(await client.reach()).toEqual({ running: false })
    await expect(client.apply()).rejects.toThrow(notRunning)
  })

  describe('with a server that is not front-proxy', () => {
    let fake

    afterEach(async () => {
      fake.closeAllConnections()
      await new Promise<void>((done) => fake.close(() => done()))
    })

    it('reports a server that never answers', async () => {
      fake = http.createServer(() => {})

      const client = createAdminClient({ port: await listen(fake), timeout: 50 })

      expect(await client.reach()).toEqual({ running: true, admin: false, problem: expect.stringContaining('No answer') })
      await expect(client.apply()).rejects.toThrow('No answer')
    })

    it('reports an error answer that is not JSON', async () => {
      const token = 'a'.repeat(64)

      fake = http.createServer((req, res) => {
        expect(req.headers.host).toBe(adminHost)
        res.statusCode = req.method === 'GET' ? 200 : 500
        res.end(req.method === 'GET' ? `<meta name="front-proxy-token" content="${token}">` : 'oops')
      })

      const client = createAdminClient({ port: await listen(fake) })

      await expect(client.apply()).rejects.toThrow('The proxy answered 500')
    })
  })
})

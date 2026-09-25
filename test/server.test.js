import { jest } from '@jest/globals'
import fs from 'fs'
import http from 'http'
import os from 'os'
import { join } from 'path'
import Hapi from '@hapi/hapi'
import Server from '../src/server.js'

// Points a Server at temp files so tests never touch /etc/hosts or the real config.
const createServer = (dir, proxyHosts = {}) => {
  const server = new Server()

  server.hostFilePath = join(dir, 'hosts')
  server.proxyHostsPath = join(dir, 'proxyHosts.json')
  server.keysPath = dir
  fs.writeFileSync(server.hostFilePath, '127.0.0.1 localhost\n')
  server.saveProxyHosts(proxyHosts)

  return server
}

const readConfig = (server) => JSON.parse(fs.readFileSync(server.proxyHostsPath, 'utf8'))

describe('Server', () => {
  let dir

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'front-proxy-'))
    jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('loads hosts from the config and ignores the $comment key', () => {
    const server = createServer(dir, { 'my.local': { port: 3000 } })

    expect(readConfig(server).$comment).toBeDefined()
    expect(server.loadProxyHosts()).toEqual({ 'my.local': { port: 3000 } })
  })

  it('add writes the host to the hosts file and the config', () => {
    const server = createServer(dir)

    server.add({ host: 'my.local', port: 3000 })

    expect(fs.readFileSync(server.hostFilePath, 'utf8')).toContain('127.0.0.1 my.local')
    expect(readConfig(server)['my.local']).toEqual({ port: 3000 })
  })

  it('remove deletes the host from the hosts file and the config', () => {
    const server = createServer(dir)

    server.add({ host: 'my.local', port: 3000 })
    server.remove('my.local')

    expect(fs.readFileSync(server.hostFilePath, 'utf8')).toBe('127.0.0.1 localhost\n')
    expect(readConfig(server)['my.local']).toBeUndefined()
  })

  it('list prints every configured host', () => {
    const server = createServer(dir, { 'my.local': { port: 3000, cert: 'my.local' } })

    server.list()

    expect(console.log).toHaveBeenCalledWith('HOST: my.local | PORT: 3000 | CERT: my.local')
  })

  describe('proxy route', () => {
    let target
    let hapiServer

    beforeEach(async () => {
      target = http.createServer((req, res) => res.end(`hello from ${req.url}`))
      await new Promise((done) => target.listen(0, '127.0.0.1', done))
    })

    afterEach(async () => {
      await hapiServer.stop()
      await new Promise((done) => target.close(done))
    })

    it('proxies a known host to its local port and returns 502 for unknown hosts', async () => {
      const server = createServer(dir, { 'my.local': { port: target.address().port } })

      hapiServer = Hapi.server({ port: 0 })
      await server.startServer(hapiServer)

      const proxied = await hapiServer.inject({ url: '/page', headers: { host: 'my.local' } })
      const unknown = await hapiServer.inject({ url: '/', headers: { host: 'other.local' } })

      expect(proxied.statusCode).toBe(200)
      expect(proxied.payload).toBe('hello from /page')
      expect(unknown.statusCode).toBe(502)
    })
  })
})

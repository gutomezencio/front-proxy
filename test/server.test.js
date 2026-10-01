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

  it('keeps the config and keys in FRONT_PROXY_HOME', () => {
    process.env.FRONT_PROXY_HOME = dir

    try {
      const server = new Server()

      expect(server.proxyHostsPath).toBe(join(dir, 'proxyHosts.json'))
      expect(server.keysPath).toBe(join(dir, 'keys'))
    } finally {
      delete process.env.FRONT_PROXY_HOME
    }
  })

  it('loads hosts from the config and ignores the $comment key', () => {
    const server = createServer(dir, { 'my.local': { port: 3000 } })

    expect(readConfig(server).$comment).toBeDefined()
    expect(server.loadProxyHosts()).toEqual({ 'my.local': { port: 3000 } })
  })

  it('add saves the host to the config without touching the hosts file', () => {
    const server = createServer(dir)

    server.add({ host: 'my.local', port: 3000 })

    expect(fs.readFileSync(server.hostFilePath, 'utf8')).toBe('127.0.0.1 localhost\n')
    expect(readConfig(server)['my.local']).toEqual({ port: 3000 })
  })

  it('remove deletes the host from the config without touching the hosts file', () => {
    const server = createServer(dir)

    server.add({ host: 'my.local', port: 3000 })
    server.remove('my.local')

    expect(fs.readFileSync(server.hostFilePath, 'utf8')).toBe('127.0.0.1 localhost\n')
    expect(readConfig(server)['my.local']).toBeUndefined()
  })

  describe('hosts file', () => {
    const block = [
      '# <FRONT-PROXY-HOSTS>',
      '# > my.local < Host added by front-proxy',
      '127.0.0.1 my.local',
      '# > api.local < Host added by front-proxy',
      '127.0.0.1 api.local',
      '# </FRONT-PROXY-HOSTS>',
    ].join('\n')

    const readHosts = (server) => fs.readFileSync(server.hostFilePath, 'utf8')

    it('writeHostsFile writes one block with every configured host', () => {
      const server = createServer(dir, { 'my.local': { port: 3000 }, 'api.local': { port: 4000 } })

      server.writeHostsFile()
      server.writeHostsFile()

      expect(readHosts(server)).toBe(`127.0.0.1 localhost\n\n${block}\n`)
    })

    it('cleanHostsFile removes the block and legacy entries, keeping the user lines', () => {
      const server = createServer(dir)
      const original = '127.0.0.1 localhost\n127.0.0.1 other.local\n'

      fs.writeFileSync(
        server.hostFilePath,
        [
          '127.0.0.1 localhost',
          '',
          '# > old.local < Host added by front-proxy',
          '127.0.0.1 old.local',
          '127.0.0.1 other.local',
          '',
          block.replace(/\n/g, '\r\n'),
          '',
        ].join('\n'),
      )

      server.cleanHostsFile()

      expect(readHosts(server)).toBe(original)
    })

    it('cleanHostsFile only drops the entries after a start line without an end line', () => {
      const server = createServer(dir)

      fs.writeFileSync(
        server.hostFilePath,
        '127.0.0.1 localhost\n# <FRONT-PROXY-HOSTS>\n# > my.local < Host added by front-proxy\n127.0.0.1 my.local\n127.0.0.1 other.local\n',
      )

      server.cleanHostsFile()

      expect(readHosts(server)).toBe('127.0.0.1 localhost\n127.0.0.1 other.local\n')
    })

    it('stop removes the hosts, unless they are persisted', async () => {
      const server = createServer(dir, { 'my.local': { port: 3000 }, 'api.local': { port: 4000 } })

      jest.spyOn(process, 'exit').mockImplementation(() => {})

      server.writeHostsFile()
      server.persistHosts = true
      await server.stop()

      expect(readHosts(server)).toContain(block)

      server.stopping = false
      server.persistHosts = false
      await server.stop()

      expect(readHosts(server)).toBe('127.0.0.1 localhost\n')
      expect(process.exit).toHaveBeenCalledTimes(2)
    })
  })

  it('list prints every configured host', () => {
    const server = createServer(dir, { 'my.local': { port: 3000, cert: 'my.local' } })

    server.list()

    expect(console.log).toHaveBeenCalledWith('ℹ Hosts\n\n  my.local  →  :3000   cert: my.local\n')
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

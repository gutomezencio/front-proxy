import { jest } from '@jest/globals'
import fs from 'fs'
import http from 'http'
import os from 'os'
import { join } from 'path'
import Hapi from '@hapi/hapi'
import Server from '../src/server.js'
import { adminHost } from '../src/hosts-validation.js'

const origin = `http://${adminHost}`

describe('admin page', () => {
  let dir
  let target
  let server
  let hapiServer
  let token

  const readConfig = () => JSON.parse(fs.readFileSync(server.proxyHostsPath, 'utf8'))

  // A mutating request as the admin page sends it; `overrides` replaces or drops (undefined) headers.
  const send = (method, url, payload, overrides = {}) => {
    const headers = {
      host: adminHost,
      origin,
      'content-type': 'application/json',
      'x-front-proxy-token': token,
      ...overrides,
    }

    Object.keys(headers).forEach((name) => headers[name] === undefined && delete headers[name])

    return hapiServer.inject({ method, url, headers, payload: payload === undefined ? undefined : JSON.stringify(payload) })
  }

  const get = (url, options = {}) => hapiServer.inject({ url, headers: { host: adminHost }, ...options })

  beforeEach(async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'front-proxy-'))
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})

    target = http.createServer((req, res) => res.end(`hello from ${req.url}`))
    await new Promise((done) => target.listen(0, '127.0.0.1', done))

    server = new Server()
    server.hostFilePath = join(dir, 'hosts')
    server.proxyHostsPath = join(dir, 'proxyHosts.json')
    server.keysPath = dir
    fs.writeFileSync(server.hostFilePath, '127.0.0.1 localhost\n')
    server.saveProxyHosts({ 'my.local': { port: target.address().port } })
    server.adminEnabled = true

    hapiServer = Hapi.server({ port: 0 })
    await server.startServer(hapiServer)

    const page = await get('/')
    ;[, token] = page.payload.match(/name="front-proxy-token" content="([a-f0-9]{64})"/)
  })

  afterEach(async () => {
    await hapiServer.stop()
    await new Promise((done) => target.close(done))
    jest.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('serves the page with security headers, without taking over the other hosts', async () => {
    const page = await get('/')
    const css = await get('/vendor/pico.min.css')
    const unknown = await get('/../server.js')
    const proxied = await hapiServer.inject({ url: '/my', headers: { host: 'my.local' } })

    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toMatch(/^text\/html/)
    expect(page.headers['content-security-policy']).toContain("default-src 'self'")
    expect(page.headers['x-frame-options']).toBe('DENY')
    expect(page.payload).not.toContain('__FRONT_PROXY_TOKEN__')
    expect(css.statusCode).toBe(200)
    expect(unknown.statusCode).toBe(404)
    expect(proxied.payload).toBe('hello from /my')
  })

  it('adds, edits and removes hosts in the config, marking them pending', async () => {
    const initial = JSON.parse((await get('/api/state')).payload)

    expect(initial.pending).toBe(false)
    expect(initial.config['my.local']).toEqual({ port: target.address().port, certStatus: 'default' })

    const added = await send('POST', '/api/hosts', { host: ' New.Local ', port: 4000 })

    expect(added.statusCode).toBe(201)
    expect(JSON.parse(added.payload).pending).toBe(true)
    expect(readConfig()['new.local']).toEqual({ port: 4000 })
    expect(fs.readFileSync(server.hostFilePath, 'utf8')).toBe('127.0.0.1 localhost\n')

    expect((await send('PUT', '/api/hosts/new.local', { port: '5000' })).statusCode).toBe(200)
    expect(readConfig()['new.local']).toEqual({ port: 5000 })

    expect((await send('DELETE', '/api/hosts/new.local')).statusCode).toBe(200)
    expect(readConfig()['new.local']).toBeUndefined()
  })

  it('rejects requests that do not come from the admin page on this machine', async () => {
    const body = { host: 'evil.local', port: 4000 }

    expect((await send('POST', '/api/hosts', body, { origin: 'http://evil.com' })).statusCode).toBe(403)
    expect((await send('POST', '/api/hosts', body, { origin: undefined })).statusCode).toBe(403)
    expect((await send('POST', '/api/hosts', body, { 'x-front-proxy-token': 'nope' })).statusCode).toBe(403)
    expect((await send('POST', '/api/hosts', body, { 'content-type': 'text/plain' })).statusCode).toBe(415)
    expect((await send('POST', '/api/hosts', body, { host: 'evil.com' })).statusCode).toBe(502)
    expect((await get('/api/state', { remoteAddress: '192.168.1.5' })).statusCode).toBe(403)
    expect(readConfig()['evil.local']).toBeUndefined()
  })

  it('validates the hosts and ports it saves', async () => {
    const before = readConfig()

    expect((await send('POST', '/api/hosts', { host: 'a.local\n1.2.3.4 x', port: 4000 })).statusCode).toBe(400)
    expect((await send('POST', '/api/hosts', { host: 'a.local', port: 443 })).statusCode).toBe(400)
    expect((await send('POST', '/api/hosts', { host: adminHost, port: 4000 })).statusCode).toBe(400)
    expect((await send('POST', '/api/hosts', { host: 'a.local', port: 4000, cert: '../x' })).statusCode).toBe(400)
    expect((await send('POST', '/api/hosts', { host: 'my.local', port: 4000 })).statusCode).toBe(409)
    expect((await send('PUT', '/api/hosts/missing.local', { port: 4000 })).statusCode).toBe(404)
    expect((await send('POST', '/api/hosts', 'x'.repeat(2000))).statusCode).toBe(413)
    expect(readConfig()).toEqual(before)
  })

  it('applies the config to the running proxy and /etc/hosts', async () => {
    await send('POST', '/api/hosts', { host: 'new.local', port: target.address().port })

    const applied = await send('POST', '/api/apply')
    const proxied = await hapiServer.inject({ url: '/new', headers: { host: 'new.local' } })
    const hosts = fs.readFileSync(server.hostFilePath, 'utf8')

    expect(applied.statusCode).toBe(200)
    expect(JSON.parse(applied.payload).pending).toBe(false)
    expect(proxied.payload).toBe('hello from /new')
    expect(hosts).toContain('127.0.0.1 new.local')
    expect(hosts).toContain(`127.0.0.1 ${adminHost}`)
  })

  it('reports which configured ports have something listening', async () => {
    const closed = http.createServer()
    await new Promise((done) => closed.listen(0, '127.0.0.1', done))
    const closedPort = closed.address().port
    await new Promise((done) => closed.close(done))

    await send('POST', '/api/hosts', { host: 'down.local', port: closedPort })

    const status = JSON.parse((await get('/api/status')).payload)

    expect(status).toEqual({ 'my.local': 'up', 'down.local': 'down' })
  })
})

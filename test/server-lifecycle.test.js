import { jest } from '@jest/globals'
import fs from 'fs'
import net from 'net'
import os from 'os'
import tls from 'tls'
import { join } from 'path'
import Server from '../src/server.js'
import { writeCert } from './helpers/certs.js'

const stopSignals = ['SIGINT', 'SIGTERM', 'SIGHUP']

// A Server on temp files and random ports, so nothing touches /etc/hosts or binds 80/443.
const createServer = (dir, proxyHosts = {}) => {
  const server = new Server()

  server.hostFilePath = join(dir, 'hosts')
  server.proxyHostsPath = join(dir, 'proxyHosts.json')
  server.keysPath = dir
  server.ports = { http: 0, https: 0 }
  fs.writeFileSync(server.hostFilePath, '127.0.0.1 localhost\n')
  server.saveProxyHosts(proxyHosts)

  return server
}

const logged = () => console.log.mock.calls.map(([line]) => line).join('\n')

// The CN of the cert the HTTPS server presents for `servername`.
const servedCertName = (port, servername) =>
  new Promise((done, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false }, () => {
      done(socket.getPeerCertificate().subject.CN)
      socket.end()
    })
    socket.on('error', reject)
  })

describe('Server lifecycle', () => {
  let dir
  let listeners

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'front-proxy-'))
    listeners = Object.fromEntries(stopSignals.map((signal) => [signal, process.listeners(signal)]))
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(process, 'exit').mockImplementation(() => {})
  })

  afterEach(() => {
    // start() adds stop handlers for these signals; drop them so tests don't leak them.
    stopSignals.forEach((signal) => {
      process.listeners(signal)
        .filter((listener) => !listeners[signal].includes(listener))
        .forEach((listener) => process.removeListener(signal, listener))
    })
    jest.restoreAllMocks()
    process.exitCode = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('starts with HTTP only when there is no default cert, then stops cleanly', async () => {
    const server = createServer(dir, { 'my.local': { port: 3000 } })

    await server.start()

    const hosts = fs.readFileSync(server.hostFilePath, 'utf8')

    expect(server.ServerHTTP.info.port).toBeGreaterThan(0)
    expect(server.ServerHTTPS).toBeUndefined()
    expect(hosts).toContain('127.0.0.1 my.local')
    expect(hosts).toContain('127.0.0.1 front-proxy.localhost')
    expect(logged()).toContain('front-proxy is running')
    expect(logged()).toContain('disabled: run front-proxy generate-certs')
    expect(logged()).toContain('http://front-proxy.localhost')

    await server.stop({ fromSignal: true })

    expect(fs.readFileSync(server.hostFilePath, 'utf8')).toBe('127.0.0.1 localhost\n')
    expect(process.exit).toHaveBeenCalled()
  })

  it('serves each host its own cert over HTTPS, and the default cert otherwise', async () => {
    writeCert(dir, 'default', 'localhost')
    writeCert(dir, 'my.local')

    const server = createServer(dir, { 'my.local': { port: 3000, cert: 'my.local' } })

    await server.start({ persistHosts: true, admin: false })

    const { port } = server.ServerHTTPS.info

    expect(await servedCertName(port, 'my.local')).toBe('my.local')
    expect(await servedCertName(port, 'other.local')).toBe('localhost')
    expect(fs.readFileSync(server.hostFilePath, 'utf8')).not.toContain('front-proxy.localhost')
    expect(logged()).toContain('kept there after stopping')

    await server.stop()

    // --persist-hosts keeps the block.
    expect(fs.readFileSync(server.hostFilePath, 'utf8')).toContain('127.0.0.1 my.local')
  })

  it('applyConfig loads a new cert into the running HTTPS server', async () => {
    writeCert(dir, 'default', 'localhost')

    const server = createServer(dir, { 'my.local': { port: 3000 } })

    await server.start()
    writeCert(dir, 'my.local')
    server.saveProxyHosts({ 'my.local': { port: 3000, cert: 'my.local' } })

    expect(server.applyConfig()).toEqual({ httpsNeedsRestart: false })
    expect(await servedCertName(server.ServerHTTPS.info.port, 'my.local')).toBe('my.local')

    await server.stop()
  })

  it('applyConfig says HTTPS needs a restart when the default cert appeared after starting', async () => {
    const server = createServer(dir)

    await server.start()
    writeCert(dir, 'default', 'localhost')

    expect(server.applyConfig()).toEqual({ httpsNeedsRestart: true })
    expect(logged()).toContain('No hosts configured')

    await server.stop()
  })

  it('warns about a missing cert and falls back to the default one', () => {
    const server = createServer(dir, { 'my.local': { port: 3000, cert: 'missing' } })

    expect(server.getSecureContexts()).toEqual({})
    expect(console.warn.mock.calls[0][0]).toContain('Cert "missing" for my.local not found')
  })

  it('cleans up and exits with 1 when a port is taken', async () => {
    const blocker = net.createServer()
    await new Promise((done) => blocker.listen(0, done))

    const server = createServer(dir, { 'my.local': { port: 3000 } })

    server.ports.http = blocker.address().port

    try {
      await server.start({ persistHosts: true })
    } finally {
      await new Promise((done) => blocker.close(done))
    }

    expect(process.exitCode).toBe(1)
    expect(console.error.mock.calls[0][0]).toContain("front-proxy couldn't start")
    // A failed start never keeps the hosts, even with --persist-hosts.
    expect(fs.readFileSync(server.hostFilePath, 'utf8')).toBe('127.0.0.1 localhost\n')
  })

  it('reports when the hosts file cannot be cleaned while stopping', async () => {
    const server = createServer(dir)

    server.hostFilePath = join(dir, 'missing', 'hosts')
    await server.stop()

    expect(console.error.mock.calls[0][0]).toContain("Couldn't clean")
    expect(logged()).toContain('The next start cleans them')
  })
})

describe('generateCerts', () => {
  let dir
  let bin

  // Stands in for mkcert: writes the cert files, or fails for fail.local.
  const fakeMkcert = `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
if (args[0] === '-help' || args[0] === '-install') process.exit(0)
const domains = args.slice(4)
if (domains.includes('fail.local')) { process.stderr.write('mkcert: boom\\n'); process.exit(1) }
fs.writeFileSync(args[1], 'cert for ' + domains.join(' '))
fs.writeFileSync(args[3], 'key')
`

  const readKeysFile = (name) => fs.readFileSync(join(dir, `_private-${name}-cert.pem`), 'utf8')

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'front-proxy-'))
    bin = fs.mkdtempSync(join(os.tmpdir(), 'front-proxy-bin-'))
    fs.writeFileSync(join(bin, 'mkcert'), fakeMkcert, { mode: 0o755 })
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    process.exitCode = undefined
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(bin, { recursive: true, force: true })
  })

  const createServer = (proxyHosts) => {
    const server = new Server()

    server.proxyHostsPath = join(dir, 'proxyHosts.json')
    server.keysPath = dir
    server.mkcertPath = join(bin, 'mkcert')
    server.saveProxyHosts(proxyHosts)

    return server
  }

  const config = (server) => JSON.parse(fs.readFileSync(server.proxyHostsPath, 'utf8'))

  it('creates the default cert and one cert per host, and sets "cert" in the config', async () => {
    const server = createServer({ 'my.local': { port: 3000 }, 'api.local': { port: 4000 } })

    await server.generateCerts(true)

    expect(readKeysFile('default')).toBe('cert for localhost 127.0.0.1 ::1 front-proxy.localhost')
    expect(readKeysFile('my.local')).toBe('cert for my.local')
    expect(config(server)['my.local']).toEqual({ port: 3000, cert: 'my.local' })
    expect(config(server)['api.local']).toEqual({ port: 4000, cert: 'api.local' })
  })

  it('warns when the host is not in the config yet', async () => {
    const server = createServer({})

    await server.generateCerts('new.local')

    expect(readKeysFile('new.local')).toBe('cert for new.local')
    expect(console.warn.mock.calls[0][0]).toContain("new.local isn't in the proxy config yet")
    expect(config(server)['new.local']).toBeUndefined()
  })

  it('reports a failed cert and leaves that host unchanged', async () => {
    const server = createServer({ 'fail.local': { port: 3000 } })

    await server.generateCerts(true)

    expect(process.exitCode).toBe(1)
    expect(console.error.mock.calls[0][0]).toContain('mkcert: boom')
    expect(config(server)['fail.local']).toEqual({ port: 3000 })
  })

  it('needs at least one host', async () => {
    await createServer({}).generateCerts(true)

    expect(console.error.mock.calls[0][0]).toContain('No hosts configured')
  })

  it('explains how to install mkcert when it is not on the PATH', async () => {
    const server = createServer({ 'my.local': { port: 3000 } })

    server.mkcertPath = join(bin, 'missing-mkcert')
    await server.generateCerts(true)

    expect(console.error.mock.calls[0][0]).toContain('mkcert was not found')
  })
})

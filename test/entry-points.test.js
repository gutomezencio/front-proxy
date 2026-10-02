import { jest } from '@jest/globals'
import fs from 'fs'
import os from 'os'
import { join } from 'path'

// The entry scripts run on import, so each test sets process.argv first and imports a fresh
// copy. child_process is mocked: nothing is spawned and mkcert never runs.

const child = { on: jest.fn() }
const spawn = jest.fn(() => child)

jest.unstable_mockModule('child_process', () => ({
  spawn,
  execFile: jest.fn(),
  execFileSync: jest.fn(),
}))

describe('entry points', () => {
  const argv = process.argv
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  let dir
  let listeners

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'front-proxy-'))
    process.env.FRONT_PROXY_HOME = join(dir, 'config')
    listeners = Object.fromEntries(signals.map((signal) => [signal, process.listeners(signal)]))
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
    spawn.mockClear()
    child.on.mockClear()
    jest.resetModules()
  })

  afterEach(() => {
    signals.forEach((signal) => {
      process.listeners(signal)
        .filter((listener) => !listeners[signal].includes(listener))
        .forEach((listener) => process.removeListener(signal, listener))
    })
    process.argv = argv
    process.exitCode = undefined
    delete process.env.FRONT_PROXY_HOME
    jest.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('the bin runs start.js, which spawns the proxy under sudo for start', async () => {
    process.argv = ['node', 'front-proxy', '--persist-hosts']

    await import('../src/bin-running.js')

    const [executable, args, options] = spawn.mock.calls[0]

    expect(executable).toBe('sudo')
    expect(args).toContain(`FRONT_PROXY_HOME=${process.env.FRONT_PROXY_HOME}`)
    expect(args.at(-1)).toBe('--persist-hosts')
    expect(options.env.FRONT_PROXY_HOME).toBe(process.env.FRONT_PROXY_HOME)
    expect(console.log.mock.calls[0][0]).toContain('front-proxy needs your password')
    expect(fs.existsSync(join(process.env.FRONT_PROXY_HOME, 'proxyHosts.json'))).toBe(true)

    // The wrapper exits with the child's exit code.
    const [, onExit] = child.on.mock.calls.find(([event]) => event === 'exit')

    onExit(3)
    expect(process.exitCode).toBe(3)
  })

  it('start.js runs the other commands as the current user', async () => {
    process.argv = ['node', 'front-proxy', 'list']

    await import('../src/start.js')

    const [executable, args] = spawn.mock.calls[0]

    expect(executable).toBe(process.execPath)
    expect(args.slice(1)).toEqual(['list'])
    expect(console.log).not.toHaveBeenCalled()
  })

  it('proxy-server.js runs the command', async () => {
    process.argv = ['node', 'proxy-server.js', 'add', 'my.local:3000']

    await import('../src/proxy-server.js')

    const config = JSON.parse(fs.readFileSync(join(process.env.FRONT_PROXY_HOME, 'proxyHosts.json'), 'utf8'))

    expect(config['my.local']).toEqual({ port: 3000 })
  })

  it('proxy-server.js reports invalid input', async () => {
    process.argv = ['node', 'proxy-server.js', 'add', 'my.local:443']

    await import('../src/proxy-server.js')

    expect(process.exitCode).toBe(1)
    expect(console.error.mock.calls[0][0]).toContain('Port 443 is used by front-proxy itself')
  })
})

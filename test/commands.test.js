import { jest } from '@jest/globals'
import { UsageError, fail, parseHostPort, runCommand } from '../src/commands.js'

const fakeServer = () => ({
  add: jest.fn(),
  remove: jest.fn(),
  list: jest.fn(),
  generateCerts: jest.fn(() => Promise.resolve()),
  start: jest.fn(() => Promise.resolve()),
})

describe('commands', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    process.exitCode = undefined
  })

  it('parseHostPort validates and normalizes host:port', () => {
    expect(parseHostPort('My.Local:3000')).toEqual({ host: 'my.local', port: 3000 })
    expect(() => parseHostPort(':3000')).toThrow('Missing the hostname')
    expect(() => parseHostPort('my.local')).toThrow('Missing the port for my.local')
    expect(() => parseHostPort('my.local:1:2')).toThrow('more than one ":"')
    expect(() => parseHostPort('a b:3000')).toThrow(UsageError)
    expect(() => parseHostPort('my.local:443')).toThrow('used by front-proxy')
  })

  it('dispatches each command to the server', async () => {
    const server = fakeServer()

    runCommand({ command: 'add', value: 'my.local:3000' }, server)
    runCommand({ command: 'remove', value: 'My.Local:3000' }, server)
    runCommand({ command: 'list' }, server)
    await runCommand({ command: 'generate-certs' }, server)
    await runCommand({ command: 'generate-certs', value: 'My.Local' }, server)
    await runCommand({ command: 'start', persistHosts: true, admin: false }, server)

    expect(server.add).toHaveBeenCalledWith({ host: 'my.local', port: 3000 })
    expect(server.remove).toHaveBeenCalledWith('my.local')
    expect(server.list).toHaveBeenCalled()
    expect(server.generateCerts.mock.calls).toEqual([[true], ['my.local']])
    expect(server.start).toHaveBeenCalledWith({ persistHosts: true, admin: false })
  })

  it('rejects an invalid generate-certs host before calling mkcert', () => {
    const server = fakeServer()

    expect(() => runCommand({ command: 'generate-certs', value: '../x' }, server)).toThrow(UsageError)
    expect(server.generateCerts).not.toHaveBeenCalled()
  })

  it('reports failures of async commands and sets the exit code', async () => {
    const server = fakeServer()

    server.start.mockRejectedValue(new Error('port taken'))
    await runCommand({ command: 'start' }, server)

    expect(process.exitCode).toBe(1)
    expect(console.error.mock.calls[0][0]).toContain('port taken')
  })

  it('fail prints usage help for usage errors', () => {
    fail(new UsageError('Missing the port'))
    fail('plain string')

    expect(console.error.mock.calls[0][0]).toContain('front-proxy add myhost.local:3000')
    expect(console.error.mock.calls[1][0]).toContain('plain string')
    expect(process.exitCode).toBe(1)
  })
})

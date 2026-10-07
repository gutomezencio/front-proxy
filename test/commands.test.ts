import { jest } from '@jest/globals'

// The MCP server would take over stdin/stdout; dispatching to it is all that's tested here.
const startMcpServer = jest.fn(() => Promise.resolve())

jest.unstable_mockModule('../src/mcp.js', () => ({ startMcpServer }))

const { UsageError, fail, parseHostPort, runCommand } = await import('../src/commands.js')

// Only the methods runCommand calls.
const fakeServer = (): any => ({
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

  it('runs the MCP server with the server, and reports when it fails to start', async () => {
    const server = fakeServer()

    await runCommand({ command: 'mcp' }, server)

    expect(startMcpServer).toHaveBeenCalledWith(server)

    startMcpServer.mockRejectedValueOnce(new Error('stdin closed'))
    await runCommand({ command: 'mcp' }, server)

    expect(process.exitCode).toBe(1)
    expect(jest.mocked(console.error).mock.calls[0][0]).toContain('stdin closed')
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
    expect(jest.mocked(console.error).mock.calls[0][0]).toContain('port taken')
  })

  it('fail prints usage help for usage errors', () => {
    fail(new UsageError('Missing the port'))
    fail('plain string')

    expect(jest.mocked(console.error).mock.calls[0][0]).toContain('front-proxy add myhost.local:3000')
    expect(jest.mocked(console.error).mock.calls[1][0]).toContain('plain string')
    expect(process.exitCode).toBe(1)
  })
})

import type Server from './server.js'
import type { ParsedCommand } from './cli-args.js'
import { hostInputSchema, normalizeHost, validatePort } from './hosts-validation.js'
import { startMcpServer } from './mcp.js'
import { colors, error } from './output.js'

// Dispatches a parsed CLI command (from parseCliArgs) to a Server. Lives apart from
// proxy-server.js so it can be imported and tested without running anything.

export class UsageError extends Error {}

export const fail = (err: unknown) => {
  process.exitCode = 1

  if (err instanceof UsageError) {
    return error(err.message, `Use host:port, eq.: ${colors.cyan('front-proxy add myhost.local:3000')}`)
  }

  error('Something went wrong', err instanceof Error ? err.message : String(err))
}

// Returns the normalized host, or throws a UsageError when it isn't a valid hostname.
const checkHost = (value: string) => {
  const result = hostInputSchema.safeParse(value)

  if (!result.success) {
    throw new UsageError(result.error.issues[0].message)
  }

  return result.data
}

// Returns { host, port } from "host:port", or throws a UsageError.
export const parseHostPort = (value: string) => {
  const [rawHost, rawPort, ...rest] = value.split(':')

  if (!rawHost) {
    throw new UsageError('Missing the hostname and port')
  }

  if (!rawPort) {
    throw new UsageError(`Missing the port for ${rawHost}`)
  }

  if (rest.length) {
    throw new UsageError(`"${value}" has more than one ":"`)
  }

  const host = checkHost(rawHost)
  const { port, error: portError } = validatePort(rawPort)

  if (portError !== undefined) {
    throw new UsageError(portError)
  }

  return { host, port }
}

// Async commands resolve once done; their errors are reported with fail().
export const runCommand = (
  { command, value, persistHosts, admin }: Partial<ParsedCommand> & Pick<ParsedCommand, 'command'>,
  server: Server,
) => {
  if (command === 'add') {
    return server.add(parseHostPort(String(value)))
  }

  if (command === 'remove') {
    const [host] = String(value).split(':')

    return server.remove(normalizeHost(host))
  }

  if (command === 'list') {
    return server.list()
  }

  if (command === 'generate-certs') {
    return server.generateCerts(value === undefined ? true : checkHost(value)).catch(fail)
  }

  if (command === 'mcp') {
    return startMcpServer(server).catch(fail)
  }

  return server.start({ persistHosts, admin }).catch(fail)
}

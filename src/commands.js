import { normalizeHost, validateHost, validatePort } from './hosts-validation.js'
import { colors, error } from './output.js'

// Dispatches a parsed CLI command (from parseCliArgs) to a Server. Lives apart from
// proxy-server.js so it can be imported and tested without running anything.

export class UsageError extends Error {}

export const fail = (err) => {
  process.exitCode = 1

  if (err instanceof UsageError) {
    return error(err.message, `Use host:port, eq.: ${colors.cyan('front-proxy add myhost.local:3000')}`)
  }

  error('Something went wrong', err.message || String(err))
}

// Throws a UsageError when the host isn't a valid hostname.
const checkHost = (value) => {
  const host = normalizeHost(value)
  const problem = validateHost(host)

  if (problem) {
    throw new UsageError(problem)
  }

  return host
}

// Returns { host, port } from "host:port", or throws a UsageError.
export const parseHostPort = (value) => {
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

  if (portError) {
    throw new UsageError(portError)
  }

  return { host, port }
}

// Async commands resolve once done; their errors are reported with fail().
export const runCommand = ({ command, value, persistHosts, admin }, server) => {
  if (command === 'add') {
    return server.add(parseHostPort(value))
  }

  if (command === 'remove') {
    const [host] = value.split(':')

    return server.remove(normalizeHost(host))
  }

  if (command === 'list') {
    return server.list()
  }

  if (command === 'generate-certs') {
    return server.generateCerts(value === undefined ? true : checkHost(value)).catch(fail)
  }

  return server.start({ persistHosts, admin }).catch(fail)
}

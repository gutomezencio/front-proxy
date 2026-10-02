import Server from './server.js'
import { parseCliArgs } from './cli-args.js'
import { normalizeHost, validateHost, validatePort } from './hosts-validation.js'
import { colors, error } from './output.js'

class UsageError extends Error {}

const fail = (err) => {
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

const ProxyServer = new Server()

try {
  const { command, value, persistHosts, admin } = parseCliArgs()

  if (command === 'add') {
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

    ProxyServer.add({ host, port })
  } else if (command === 'remove') {
    const [host,] = value.split(':')

    ProxyServer.remove(normalizeHost(host))
  } else if (command === 'list') {
    ProxyServer.list()
  } else if (command === 'generate-certs') {
    ProxyServer.generateCerts(value === undefined ? true : checkHost(value)).catch(fail)
  } else {
    ProxyServer.start({ persistHosts, admin }).catch(fail)
  }
} catch (err) {
  fail(err)
}

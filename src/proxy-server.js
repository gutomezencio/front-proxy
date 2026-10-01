import Server from './server.js'
import { parseCliArgs } from './cli-args.js'
import { colors, error } from './output.js'

class UsageError extends Error {}

const fail = (err) => {
  process.exitCode = 1

  if (err instanceof UsageError) {
    return error(err.message, `Use host:port, eq.: ${colors.cyan('front-proxy add myhost.local:3000')}`)
  }

  error('Something went wrong', err.message || String(err))
}

const ProxyServer = new Server()

try {
  const { command, value, persistHosts } = parseCliArgs()

  if (command === 'add') {
    const [host, port] = value.split(':')

    if (!host) {
      throw new UsageError('Missing the hostname and port')
    }

    if (!port) {
      throw new UsageError(`Missing the port for ${host}`)
    }

    ProxyServer.add({
      host,
      port: parseInt(port)
    })
  } else if (command === 'remove') {
    const [host,] = value.split(':')

    ProxyServer.remove(host)
  } else if (command === 'list') {
    ProxyServer.list()
  } else if (command === 'generate-certs') {
    ProxyServer.generateCerts(value || true).catch(fail)
  } else {
    ProxyServer.start({ persistHosts }).catch(fail)
  }
} catch (err) {
  fail(err)
}

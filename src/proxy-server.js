import Server from './server.js'
import { parseCliArgs } from './cli-args.js'

const ProxyServer = new Server()

try {
  const { command, value } = parseCliArgs()

  if (command === 'add') {
    const [host, port] = value.split(':')

    if (!host) {
      throw "You must pass a hostname and port if you want to add a proxy rule, eq.: myhost:3000"
    }

    if (!port) {
      throw "You must pass a port for this hostname, eq.: myhost:3000"
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
    ProxyServer.generateCerts(value || true)
  } else {
    ProxyServer.start()
  }
} catch (err) {
  console.error(err)
}

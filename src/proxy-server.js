import Server from './server.js'

const ProxyServer = new Server()
const cliArgs = require('yargs').argv
const { add, remove, list, generateCerts } = cliArgs

try {
  if (add) {
    const [host, port] = add.split(':')

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
  } else if (remove) {
    const [host,] = remove.split(':')

    ProxyServer.remove(host)
  } else if (list) {
    ProxyServer.list()
  } else if (generateCerts) {
    ProxyServer.generateCerts(generateCerts)
  } else {
    ProxyServer.start()
  }
} catch (err) {
  console.error(err)
}

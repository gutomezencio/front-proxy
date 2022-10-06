import Hapi from 'hapi'
import h2o2 from 'h2o2'
import fs from 'fs'
import { resolve } from 'path'
import proxyHosts from '../config/proxyHosts.json'

export default class Server {
  static tls
  static ServerHTTP
  static ServerHTTPS
  static hostFilePath
  static proxyHostsPath

  constructor () {
    this.tls = {
      key: fs.readFileSync(resolve(__dirname, '../keys/example-key.pem')),
      cert: fs.readFileSync(resolve(__dirname,'../keys/example-cert.pem'))
    }
    this.ServerHTTP = new Hapi.server({
      port: 80,
    })

    this.ServerHTTPS = new Hapi.server({
      port: 443,
      tls: this.tls
    })

    this.hostFilePath = resolve('/', 'etc/hosts')

    this.proxyHostsPath = resolve(__dirname, '../config/proxyHosts.json')
  }

  start () {
    this.startServer(this.ServerHTTP)
    this.startServer(this.ServerHTTPS)
  }

  async startServer (server) {
    await server.register({ plugin: h2o2 })

    server.route({
      method: '*',
      path: '/{path*}',
      options: {
        handler (request, h) {
          return h.proxy({
            ...proxyHosts[request.headers.host],
            host: 'localhost',
            passThrough: true
          })
        },
        payload: {
          output: 'stream',
          parse: false
        }
      }
    })

    await server.start()

    const { settings } = server

    let serverInfo = `in port ${settings.port}`
    let tlsInfo = 'with HTTP'

    if (settings.tls) {
      tlsInfo = 'with HTTPS'
    }

    console.log(`Server running ${serverInfo} ${tlsInfo}`)
  }

  async getHostFileConente () {
     const fileContent = await Promise.resolve(fs.readFileSync(this.hostFilePath))

     return fileContent.toString()
  }

  async checkAlreadyExist (host) {
    const hostFileContent = await this.getHostFileConente()

    return hostFileContent.includes(`127.0.0.1 ${host}`)
  }

  async add ({ host, port }) {
    const hasTheHostinOS = await this.checkAlreadyExist(host)

    if (!hasTheHostinOS && !proxyHosts[host]) {
      await Promise.resolve(fs.appendFileSync(this.hostFilePath, `\r\n# > ${host} < Host added by front-proxy\r\n127.0.0.1 ${host}`))
      let newProxyHostsFile = {
        ...proxyHosts
      }

      newProxyHostsFile[host] = {
        port
      }

      await Promise.resolve(fs.writeFileSync(this.proxyHostsPath, JSON.stringify(newProxyHostsFile, null, 2)))
      return console.log(`The host ${host}:${port} was successfull added to config.`)
    } else {
      return console.error(`The current host is already added. Provide another one.`)
    }
  }

  async remove (host) {
    const hasTheHostinOS = await this.checkAlreadyExist(host)

    if (hasTheHostinOS && proxyHosts[host]) {
      let hostFileContent = await this.getHostFileConente()

      hostFileContent = hostFileContent.replace(`\n# > ${host} < Host added by front-proxy\n127.0.0.1 ${host}`, '')
      await Promise.resolve(fs.writeFileSync(this.hostFilePath, hostFileContent))

      const { [host]: _, ...newProxyHostsFile } = proxyHosts

      await Promise.resolve(fs.writeFileSync(this.proxyHostsPath, JSON.stringify(newProxyHostsFile, null, 2)))
    } else {
      return console.error(`Can't find the host "${host}" in your OS hosts file or in front-proxy config. Please, check the host name and try again.`)
    }
  }

  async list () {
    const hostsArray = Object.keys(proxyHosts)

    if (hostsArray.length > 0) {
      hostsArray.forEach(item => {
        console.log(`HOST: ${item} | PORT: ${proxyHosts[item].port}`)
      })
    } else {
      return console.error(`Can't find any hosts configured.`)
    }
  }

  async generateCertificate () {
    console.log(`By now we don't have an auto-generator for SSL certs.\nPlease, visit https://github.com/FiloSottile/mkcert and follow the instructions to make your own certs.`)
  }
}

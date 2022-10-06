import { exec } from 'child_process'
import { resolve } from 'path'
const cliArgs = require('yargs').argv
const { add, remove, list, generateCerts } = cliArgs
let commandArgs = ''

if (add) {
  commandArgs = `--add ${add}`
} else if (remove) {
  commandArgs = `--remove ${remove}`
} else if (list) {
  commandArgs = `--list`
} else if (generateCerts) {
  commandArgs = `--generate-certs`
}

const babelNodeBinPath = resolve(__dirname, '../node_modules/@babel/node/bin/babel-node.js')

const init = () => {
  console.log('For usage of 80 port and access the OS hosts file, you must provide your root password.\n')

  const commandOutput = exec(`sudo node ${babelNodeBinPath} ${__dirname}/proxy-server.js ${commandArgs.replace(/(&|\|)/gm, '')}`)

  commandOutput.stdout.on('data', async data => {
    console.log(data.toString())
  })

  commandOutput.stderr.on('data', (data) => {
    console.error(data.toString())
  })

  commandOutput.on('exit', (code) => {
    console.log(`Child exited with code ${code}`)
  })
}

init()

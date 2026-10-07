import fs from 'fs'
import { join } from 'path'

// Stands in for mkcert: writes the cert files, or fails for fail.local. A "fail-install" or
// "fail-default" file next to it makes `-install` or the default cert fail. (A file, because
// Jest gives tests their own process.env, which child processes don't see.)
const script = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
const failing = (what) => fs.existsSync(path.join(__dirname, 'fail-' + what))
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(1) }
if (args[0] === '-help') process.exit(0)
if (args[0] === '-install') failing('install') ? fail('mkcert: sudo needs a password') : process.exit(0)
const domains = args.slice(4)
if (domains.includes('fail.local')) fail('mkcert: boom')
if (domains.includes('localhost') && failing('default')) fail('mkcert: default boom')
fs.writeFileSync(args[1], 'cert for ' + domains.join(' '))
fs.writeFileSync(args[3], 'key')
`

// Writes the fake mkcert into `bin` and returns its path.
export const writeFakeMkcert = (bin: string) => {
  const path = join(bin, 'mkcert')

  fs.writeFileSync(path, script, { mode: 0o755 })

  return path
}

// Makes the fake mkcert in `bin` fail `-install` or the default cert.
export const failFakeMkcert = (bin: string, what: 'install' | 'default') =>
  fs.writeFileSync(join(bin, `fail-${what}`), '')

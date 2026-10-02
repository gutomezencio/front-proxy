import Server from './server.js'
import { parseCliArgs } from './cli-args.js'
import { fail, runCommand } from './commands.js'

try {
  runCommand(parseCliArgs(), new Server())
} catch (err) {
  fail(err)
}

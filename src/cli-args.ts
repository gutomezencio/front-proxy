import yargs from 'yargs'
import { z } from 'zod'

export const commands = ['start', 'add', 'remove', 'list', 'generate-certs', 'mcp'] as const

// What the entry scripts get back from parseCliArgs, checked with zod after yargs is done.
export const parsedCommandSchema = z.object({
  command: z.enum(commands),
  value: z.string().optional(),
  persistHosts: z.boolean(),
  admin: z.boolean(),
})

export type ParsedCommand = z.infer<typeof parsedCommandSchema>

// Returns { command, value, persistHosts, admin }. Running with no command means "start the servers".
export const parseCliArgs = (args = process.argv.slice(2)): ParsedCommand => {
  const argv = yargs()
    .scriptName('front-proxy')
    .command('$0', 'Start the proxy servers on ports 80 and 443', (cmd) =>
      cmd.option('persist-hosts', {
        alias: 'p',
        type: 'boolean',
        default: false,
        describe: 'Keep the hosts in /etc/hosts after the proxy stops',
      }).option('admin', {
        type: 'boolean',
        default: true,
        describe: 'Serve the admin page at http://front-proxy.localhost (--no-admin turns it off)',
      }),
    )
    .command('add <host:port>', 'Add a domain to the proxy list, eq.: myhost:3000')
    .command('remove <host>', 'Remove a domain from the proxy list')
    .command('list', 'List the domains in the proxy list')
    .command(
      'generate-certs [host]',
      'Generate certs with mkcert for one host, or for all hosts when none is passed',
    )
    .command('mcp', 'Run the MCP server on stdio, for code assistants (Claude Code, Cursor, VS Code…)')
    .strict()
    .help()
    .version(false)
    .locale('en')
    .parseSync(args)

  const [command = 'start'] = argv._
  const values: Record<string, unknown> = { add: argv['host:port'], remove: argv.host, 'generate-certs': argv.host }
  const value = values[command]

  return parsedCommandSchema.parse({
    command,
    value: value === undefined ? undefined : String(value),
    persistHosts: Boolean(argv.persistHosts),
    admin: argv.admin !== false,
  })
}

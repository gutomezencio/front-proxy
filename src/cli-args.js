import yargs from 'yargs'

// Returns { command, value }. Running with no command means "start the servers".
export const parseCliArgs = (args = process.argv.slice(2)) => {
  const argv = yargs()
    .scriptName('front-proxy')
    .command('$0', 'Start the proxy servers on ports 80 and 443')
    .command('add <host:port>', 'Add a domain to the proxy list, eq.: myhost:3000')
    .command('remove <host>', 'Remove a domain from the proxy list')
    .command('list', 'List the domains in the proxy list')
    .command(
      'generate-certs [host]',
      'Generate certs with mkcert for one host, or for all hosts when none is passed',
    )
    .strict()
    .help()
    .version(false)
    .locale('en')
    .parse(args)

  const [command = 'start'] = argv._
  const value = { add: argv['host:port'], remove: argv.host, 'generate-certs': argv.host }[command]

  return { command, value: value === undefined ? undefined : String(value) }
}

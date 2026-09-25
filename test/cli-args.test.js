import { parseCliArgs } from '../src/cli-args.js'

describe('parseCliArgs', () => {
  it('starts the servers when no command is given', () => {
    expect(parseCliArgs([])).toEqual({ command: 'start', value: undefined })
  })

  it('parses add with host:port', () => {
    expect(parseCliArgs(['add', 'my.local:3000'])).toEqual({ command: 'add', value: 'my.local:3000' })
  })

  it('parses remove with a host', () => {
    expect(parseCliArgs(['remove', 'my.local'])).toEqual({ command: 'remove', value: 'my.local' })
  })

  it('parses list', () => {
    expect(parseCliArgs(['list'])).toEqual({ command: 'list', value: undefined })
  })

  it('parses generate-certs with and without a host', () => {
    expect(parseCliArgs(['generate-certs'])).toEqual({ command: 'generate-certs', value: undefined })
    expect(parseCliArgs(['generate-certs', 'my.local'])).toEqual({
      command: 'generate-certs',
      value: 'my.local',
    })
  })

  it('rejects unknown commands and --flags', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${code}`)
    })

    expect(() => parseCliArgs(['bogus'])).toThrow('exit 1')
    expect(() => parseCliArgs(['--add', 'my.local:3000'])).toThrow('exit 1')

    jest.restoreAllMocks()
  })
})

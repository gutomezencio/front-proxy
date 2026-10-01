import { jest } from '@jest/globals'
import { colors, error, spinner, success } from '../src/output.js'

describe('output', () => {
  const env = { ...process.env }

  beforeEach(() => {
    delete process.env.FORCE_COLOR
    delete process.env.NO_COLOR
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    process.env = { ...env }
  })

  it('success prints the check mark, the title and indented details', () => {
    success('Host added', 'my.local → 127.0.0.1:3000', '', 'Restart it.')

    expect(console.log).toHaveBeenCalledWith(
      '✔ Host added\n  my.local → 127.0.0.1:3000\n\n  Restart it.\n',
    )
  })

  it('error prints to stderr with a cross', () => {
    error('Host not found', 'my.local')

    expect(console.error).toHaveBeenCalledWith('✖ Host not found\n  my.local\n')
  })

  it('colors only without a TTY when FORCE_COLOR is set, and never with NO_COLOR', () => {
    expect(colors.green('ok')).toBe('ok')

    process.env.FORCE_COLOR = '1'
    expect(colors.green('ok')).toBe('\x1b[32mok\x1b[39m')

    process.env.NO_COLOR = '1'
    expect(colors.green('ok')).toBe('ok')
  })

  it('a spinner without a TTY only prints its final line', () => {
    const write = jest.spyOn(process.stdout, 'write')

    spinner('Working…').succeed('Done')

    expect(write).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('✔ Done\n')
  })
})

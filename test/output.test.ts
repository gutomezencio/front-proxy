import { jest } from '@jest/globals'
import { blankLine, colors, error, info, spinner, success, useStderr } from '../src/output.js'

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

  it('a spinner on a TTY animates, hides the cursor and restores it when done', () => {
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)

    jest.useFakeTimers()
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })

    try {
      const working = spinner('Working…')

      jest.advanceTimersByTime(160)
      working.fail('Failed', 'details')
      working.stop()

      const output = write.mock.calls.map(([text]) => text).join('')

      expect(output).toContain('\x1b[?25l')
      expect(output).toContain('⠋')
      expect(output).toContain('⠙')
      expect(output).toContain('Working…')
      expect(output.endsWith('\x1b[?25h')).toBe(true)
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed'))
    } finally {
      jest.useRealTimers()
      if (isTTY) {
        Object.defineProperty(process.stdout, 'isTTY', isTTY)
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY
      }
    }
  })

  it('useStderr sends everything to stderr and never animates', () => {
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)

    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    useStderr()

    try {
      info('Running')
      blankLine()
      spinner('Working…').succeed('Done')

      expect(console.log).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
      expect(jest.mocked(console.error).mock.calls.map(([text]) => text)).toEqual(['ℹ Running\n', '', '✔ Done\n'])
    } finally {
      useStderr(false)
      if (isTTY) {
        Object.defineProperty(process.stdout, 'isTTY', isTTY)
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY
      }
    }

    blankLine()
    expect(console.log).toHaveBeenCalledWith('')
  })
})

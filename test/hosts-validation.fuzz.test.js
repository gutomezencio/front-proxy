import fc from 'fast-check'
import { adminHost, normalizeHost, validateCertName, validateHost, validatePort } from '../src/hosts-validation.js'

// Property-based fuzzing: hosts end up in /etc/hosts and cert names in file paths,
// so whatever passes validation must stay safe for any input.

// Strings biased towards characters that matter here, so accepted values show up often
const tricky = (maxLength) =>
  fc.oneof(
    fc.string({ unit: 'binary', maxLength }),
    fc.string({ unit: fc.constantFrom(...'aZ09.-_ \t\n\r#*/\\:\0'), maxLength }),
  )

const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,20}[a-z0-9])?$/)

describe('hosts validation (fuzz)', () => {
  it('only accepts hosts that are safe to write to /etc/hosts', () => {
    fc.assert(
      fc.property(tricky(300), (host) => {
        if (validateHost(host) !== null) return

        expect(host.length).toBeLessThanOrEqual(253)
        expect(host).toMatch(/^[a-z0-9.-]+$/i)
        expect(['localhost', adminHost]).not.toContain(host.toLowerCase())
      }),
    )
  })

  it('never throws, whatever the input', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(typeof validateHost(value)).toMatch(/^(string|object)$/)
        expect(validatePort(value)).toBeInstanceOf(Object)
        expect(typeof validateCertName(value)).toMatch(/^(string|object)$/)
      }),
    )
  })

  it('accepts hosts built from valid labels', () => {
    const host = fc
      .array(label, { minLength: 1, maxLength: 5 })
      .map((labels) => labels.join('.'))
      .filter((h) => /\D/.test(h.split('.').at(-1)) && h !== 'localhost' && h !== adminHost)

    fc.assert(fc.property(host, (h) => expect(validateHost(h)).toBeNull()))
  })

  it('returns a usable port or an error', () => {
    fc.assert(
      fc.property(fc.oneof(tricky(8), fc.integer(), fc.double()), (value) => {
        const result = validatePort(value)

        if ('error' in result) {
          expect(typeof result.error).toBe('string')
          return
        }

        expect(Number.isInteger(result.port)).toBe(true)
        expect(result.port).toBeGreaterThanOrEqual(1)
        expect(result.port).toBeLessThanOrEqual(65535)
        expect([80, 443]).not.toContain(result.port)
      }),
    )
  })

  it('accepts every port except the ones the proxy binds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 65535 }).filter((p) => p !== 80 && p !== 443),
        (port) => {
          expect(validatePort(port)).toEqual({ port })
          expect(validatePort(` ${port} `)).toEqual({ port })
        },
      ),
    )
  })

  it('only accepts cert names that stay inside the keys folder', () => {
    fc.assert(
      fc.property(tricky(140), (name) => {
        if (validateCertName(name) !== null) return

        expect(name).not.toMatch(/[/\\\0]/)
        expect(name).not.toContain('..')
        expect(name).toMatch(/^[a-z0-9]/i)
      }),
    )
  })

  it('normalizes case, whitespace and the trailing dot of valid hosts', () => {
    const host = fc.array(label, { minLength: 1, maxLength: 5 }).map((labels) => labels.join('.'))
    const space = fc.string({ unit: fc.constantFrom(' ', '\t', '\n'), maxLength: 3 })

    fc.assert(
      fc.property(host, space, space, fc.boolean(), (h, before, after, dot) => {
        expect(normalizeHost(`${before}${h.toUpperCase()}${dot ? '.' : ''}${after}`)).toBe(h)
      }),
    )
  })
})

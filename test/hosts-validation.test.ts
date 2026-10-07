import { adminHost, normalizeHost, validateCertName, validateHost, validatePort } from '../src/hosts-validation.js'

describe('hosts validation', () => {
  it('normalizes hosts', () => {
    expect(normalizeHost('  My.Local. ')).toBe('my.local')
    expect(normalizeHost(undefined)).toBe('')
  })

  it('accepts hostnames', () => {
    ;['my.local', 'local-dev.livedomain.com', 'app', 'a1.b-2.test'].forEach((host) => {
      expect(validateHost(host)).toBeNull()
    })
  })

  it('rejects anything that could inject into /etc/hosts or is reserved', () => {
    ;[
      '',
      'my.local\n127.0.0.1 evil.com',
      'a b.local',
      'my.local#x',
      '*.my.local',
      '-bad.local',
      'bad..local',
      `${'a'.repeat(64)}.local`,
      `${'a.'.repeat(127)}com`,
      '127.0.0.1',
      'localhost',
      adminHost,
      undefined,
    ].forEach((host) => {
      expect(validateHost(host)).toEqual(expect.any(String))
    })
  })

  it('accepts ports from 1 to 65535, except the proxy ports', () => {
    expect(validatePort(3000)).toEqual({ port: 3000 })
    expect(validatePort('8080')).toEqual({ port: 8080 })
    ;[0, 80, 443, 70000, '3000abc', '', '-1', '1e3', undefined].forEach((port) => {
      expect(validatePort(port).error).toEqual(expect.any(String))
    })
  })

  it('only accepts cert names that stay inside the keys folder', () => {
    expect(validateCertName('my.local')).toBeNull()
    expect(validateCertName('my_cert-1')).toBeNull()
    ;['../x', 'a/b', '..', '.hidden', '', 'a..b', 3].forEach((name) => {
      expect(validateCertName(name)).toEqual(expect.any(String))
    })
  })
})

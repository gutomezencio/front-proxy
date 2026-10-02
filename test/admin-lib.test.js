import {
  hostProblem,
  hostRows,
  httpsProblem,
  newCertHosts,
  normalizeHost,
  portProblem,
  portStatusTitle,
} from '../src/admin/lib.js'

describe('admin page helpers', () => {
  it('normalizes hosts', () => {
    expect(normalizeHost('  My.App.Local. ')).toBe('my.app.local')
  })

  it('hostProblem mirrors the server rules', () => {
    expect(hostProblem('my.local', 'front-proxy.localhost')).toBeNull()
    expect(hostProblem('')).toMatch(/Enter a host/)
    expect(hostProblem(`${'a.'.repeat(127)}com`)).toMatch(/253/)
    expect(hostProblem('a b.local')).toMatch(/letters, digits/)
    expect(hostProblem('10.0.0.1')).toMatch(/IP address/)
    expect(hostProblem('localhost')).toMatch(/can't be proxied/)
    expect(hostProblem('front-proxy.localhost', 'front-proxy.localhost')).toMatch(/reserved/)
    expect(hostProblem('front-proxy.localhost')).toBeNull()
  })

  it('portProblem accepts 1-65535 except the proxy ports', () => {
    expect(portProblem('3000')).toBeNull()
    expect(portProblem(' 8080 ')).toBeNull()
    ;['0', '65536', 'abc', '', '1.5'].forEach((port) => {
      expect(portProblem(port)).toMatch(/1 to 65535/)
    })
    expect(portProblem(80)).toMatch(/used by front-proxy/)
    expect(portProblem(443)).toMatch(/used by front-proxy/)
  })

  it('hostRows merges config and active hosts and marks what changed', () => {
    const rows = hostRows({
      config: {
        'same.local': { port: 1 },
        'new.local': { port: 2 },
        'port.local': { port: 4 },
        'cert.local': { port: 5, cert: 'cert.local' },
      },
      active: {
        'same.local': { port: 1 },
        'gone.local': { port: 3 },
        'port.local': { port: 40 },
        'cert.local': { port: 5 },
      },
    })

    expect(rows.map(({ host, change }) => [host, change])).toEqual([
      ['cert.local', 'changed'],
      ['gone.local', 'removed'],
      ['new.local', 'added'],
      ['port.local', 'changed'],
      ['same.local', null],
    ])
    expect(rows[1].entry).toEqual({ port: 3 })
    expect(rows[2].entry).toEqual({ port: 2 })
  })

  it('httpsProblem explains why HTTPS is not available', () => {
    const own = { certStatus: 'own' }
    const none = { certStatus: 'default' }

    expect(httpsProblem({ config: own, active: own }, false)).toMatch(/HTTPS is off/)
    expect(httpsProblem({ config: own, active: own }, true)).toBeNull()
    expect(httpsProblem({ config: own, active: none }, true)).toMatch(/Apply now/)
    expect(httpsProblem({ config: none, active: none }, true)).toMatch(/Needs its own cert/)
    expect(httpsProblem({ active: none }, true)).toMatch(/Needs its own cert/)
  })

  it('newCertHosts lists hosts whose own cert became active', () => {
    const before = { active: { 'a.local': { certStatus: 'default' }, 'b.local': { certStatus: 'own' } } }
    const after = {
      active: {
        'a.local': { certStatus: 'own' },
        'b.local': { certStatus: 'own' },
        'c.local': { certStatus: 'own' },
        'd.local': { certStatus: 'default' },
      },
    }

    expect(newCertHosts(before, after)).toEqual(['a.local', 'c.local'])
    expect(newCertHosts(null, after)).toEqual(['a.local', 'b.local', 'c.local'])
  })

  it('portStatusTitle describes the status dot', () => {
    expect(portStatusTitle('up', 3000)).toMatch(/Something is listening on port 3000/)
    expect(portStatusTitle('down', 3000)).toMatch(/Nothing is listening on port 3000/)
    expect(portStatusTitle(undefined, 3000)).toBe('Checking…')
  })
})

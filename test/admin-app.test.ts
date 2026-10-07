/**
 * @jest-environment jsdom
 */
import { jest } from '@jest/globals'
import fs from 'fs'
import { join } from 'path'

// Runs src/admin/app.ts against index.html in jsdom, with fetch answered by a fake API.
// app.ts keeps its state at module level, so the tests run in order on one page.

const adminDir = join(import.meta.dirname, '..', 'src', 'admin')

const entry = (port, certStatus = 'default', cert?) => ({ port, certStatus, ...(cert ? { cert } : {}) })

// A loose stand-in for the admin API's data.
const api: any = {
  state: {
    adminHost: 'front-proxy.localhost',
    https: true,
    pending: false,
    config: {
      'own.local': entry(3000, 'own', 'own.local'),
      'plain.local': entry(4000),
    },
    active: {
      'own.local': entry(3000, 'own', 'own.local'),
      'plain.local': entry(4000),
    },
  },
  status: { 'own.local': 'up', 'plain.local': 'down' },
  // Set to { status, error } to make the next mutation fail.
  failNext: null,
  requests: [],
}

const respond = (status, body) => ({ ok: status < 400, status, json: async () => body })

const fakeFetch = async (
  url,
  { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {},
) => {
  api.requests.push({ url, method, headers, body: body && JSON.parse(body) })

  if (method !== 'GET' && api.failNext) {
    const { status, error } = api.failNext
    api.failNext = null
    return respond(status, { error })
  }

  if (url === '/api/state') return respond(200, api.state)
  if (url === '/api/status') return respond(200, api.status)

  const { state } = api

  if (method === 'POST' && url === '/api/hosts') {
    const { host, port } = JSON.parse(body!)
    state.config = { ...state.config, [host]: entry(port) }
    state.pending = true
    return respond(201, state)
  }

  if (method === 'PUT') {
    const host = decodeURIComponent(url.split('/').pop())
    state.config = { ...state.config, [host]: { ...state.config[host], port: JSON.parse(body!).port } }
    state.pending = true
    return respond(200, state)
  }

  if (method === 'DELETE') {
    const { [decodeURIComponent(url.split('/').pop())]: _, ...rest } = state.config
    state.config = rest
    state.pending = true
    return respond(200, state)
  }

  if (method === 'POST' && url === '/api/apply') {
    state.active = Object.fromEntries(
      Object.entries(state.config).map(([host, value]) => [host, { ...(value as object) }]),
    )
    state.pending = false
    return respond(200, { ...state, httpsNeedsRestart: false })
  }

  return respond(404, { error: 'Not found' })
}

const flush = () => new Promise<void>((done) => setTimeout(done, 0))
const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => [...document.querySelectorAll(selector)]
const row = (host) => $$('#hosts tr').find((tr) => tr.querySelector('.host-name').textContent === host)
const click = async (node) => {
  node.click()
  await flush()
}
const submit = async (form) => {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flush()
}
const message = () => $('#message').textContent

describe('admin page', () => {
  beforeAll(async () => {
    const html = fs.readFileSync(join(adminDir, 'index.html'), 'utf8').replace('__FRONT_PROXY_TOKEN__', 'test-token')

    document.documentElement.innerHTML = html.replace(/^<!doctype html>\s*<html[^>]*>|<\/html>\s*$/gi, '')
    global.fetch = jest.fn(fakeFetch) as unknown as typeof fetch
    // jsdom doesn't implement <dialog> or the clipboard.
    HTMLDialogElement.prototype.showModal = function showModal() { this.open = true }
    HTMLDialogElement.prototype.close = function close() { this.open = false }
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: jest.fn(() => Promise.resolve()) },
      configurable: true,
    })

    await import('../src/admin/app.js')
    await flush()
    await flush()
  })

  it('renders the hosts, the HTTPS status and the icons', () => {
    expect($$('#hosts tr')).toHaveLength(2)
    expect($('#https-status').textContent).toBe('HTTPS :443')
    expect($('#pending').hidden).toBe(true)
    expect($('#empty').hidden).toBe(true)
    expect($$('[data-icon]')).toHaveLength(0)
    expect($$('svg.icon').length).toBeGreaterThan(10)
  })

  it('links HTTPS only for hosts with their own cert', () => {
    const own = row('own.local')
    const plain = row('plain.local')

    expect([...own.querySelectorAll('.links a')].map((a) => a.href)).toEqual(['http://own.local/', 'https://own.local/'])
    expect(plain.querySelectorAll('.links a')).toHaveLength(1)
    expect(plain.querySelector('.link-disabled').getAttribute('aria-disabled')).toBe('true')
    expect(plain.querySelector('.hint').dataset.tooltip).toMatch(/Needs its own cert/)
    expect(plain.querySelector('.cert-note').textContent).toMatch(/until it has its own cert/)
  })

  it('shows the port status dots', () => {
    expect(row('own.local').querySelector('.dot').className).toBe('dot up')
    expect(row('plain.local').querySelector('.dot').className).toBe('dot down')
  })

  it('sends the token with every request', () => {
    expect(api.requests.every(({ headers }) => headers['X-Front-Proxy-Token'] === 'test-token')).toBe(true)
  })

  it('copies the generate-certs command', async () => {
    const link = row('plain.local').querySelector('.copy-link')

    await click(link)

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('front-proxy generate-certs plain.local')
    expect(link.textContent).toBe('Copied')

    jest.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'))
    await click(link)

    expect(message()).toContain('Copy this command: front-proxy generate-certs plain.local')
  })

  it('validates the add form before sending it', async () => {
    const form = $('#add-form')
    const calls = api.requests.length

    form.elements.host.value = 'bad host'
    form.elements.port.value = '3000'
    await submit(form)

    expect($('#add-error').hidden).toBe(false)
    expect($('#add-error').textContent).toMatch(/letters, digits/)

    form.elements.host.value = 'front-proxy.localhost'
    await submit(form)

    expect($('#add-error').textContent).toMatch(/reserved/)

    form.elements.host.value = 'ok.local'
    form.elements.port.value = '443'
    await submit(form)

    expect($('#add-error').textContent).toMatch(/used by front-proxy/)
    expect(api.requests).toHaveLength(calls)
  })

  it('adds a host, marking it pending', async () => {
    const form = $('#add-form')

    form.elements.host.value = ' New.Local '
    form.elements.port.value = '5000'
    await submit(form)

    expect(api.requests.find(({ method, url }) => method === 'POST' && url === '/api/hosts').body).toEqual({ host: 'new.local', port: 5000 })
    expect($('#add-error').hidden).toBe(true)
    expect($('#pending').hidden).toBe(false)
    expect(row('new.local').textContent).toContain('Pending add')
    expect(message()).toContain('new.local added')
  })

  it('shows the server error when adding fails', async () => {
    const form = $('#add-form')

    api.failNext = { status: 409, error: 'new.local is already added' }
    form.elements.host.value = 'new.local'
    form.elements.port.value = '5000'
    await submit(form)

    expect($('#add-error').textContent).toBe('new.local is already added')
  })

  it('edits a port in place', async () => {
    await click([...row('plain.local').querySelectorAll('button')].find((b) => b.textContent === 'Edit port'))

    const form = row('plain.local').querySelector('.port-edit')
    const input = form.querySelector('input')

    input.value = '99999'
    await submit(form)

    expect($('#message').className).toBe('error')

    api.failNext = { status: 500, error: 'disk full' }
    input.value = '4100'
    await submit(form)

    expect(message()).toContain('disk full')

    await submit(form)

    expect(api.requests.at(-1)).toMatchObject({ method: 'PUT', url: '/api/hosts/plain.local', body: { port: 4100 } })
    expect(row('plain.local').querySelector('.old-port').textContent).toBe(':4000')
    expect(row('plain.local').textContent).toContain('Pending change')
  })

  it('cancels editing a port', async () => {
    await click([...row('own.local').querySelectorAll('button')].find((b) => b.textContent === 'Edit port'))
    expect(row('own.local').querySelector('.port-edit')).not.toBeNull()

    await click([...row('own.local').querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))
    expect(row('own.local').querySelector('.port-edit')).toBeNull()
  })

  it('removes a host after confirming', async () => {
    await click([...row('own.local').querySelectorAll('button')].find((b) => b.textContent === 'Remove'))

    const dialog = $('#confirm-remove')

    expect(dialog.open).toBe(true)
    expect($('#confirm-host').textContent).toBe('own.local')

    await click(dialog.querySelector('[data-close]'))
    expect(dialog.open).toBe(false)

    await click([...row('own.local').querySelectorAll('button')].find((b) => b.textContent === 'Remove'))
    api.failNext = { status: 404, error: "own.local isn't configured" }
    await click($('#confirm-remove-button'))

    expect(message()).toContain("own.local isn't configured")

    await click([...row('own.local').querySelectorAll('button')].find((b) => b.textContent === 'Remove'))
    await click($('#confirm-remove-button'))

    expect(api.requests.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/hosts/own.local' })
    expect(row('own.local').textContent).toContain('Pending removal')
    expect(row('own.local').querySelectorAll('button')).toHaveLength(0)
  })

  it('applies the changes', async () => {
    await click($('#apply'))

    expect($('#pending').hidden).toBe(true)
    expect(row('own.local')).toBeUndefined()
    expect(message()).toContain('Changes applied. /etc/hosts and the proxy routes are up to date.')
    expect($('#apply').disabled).toBe(false)
  })

  it('suggests restarting the browser when a new cert became active', async () => {
    api.state.config['plain.local'] = entry(4100, 'own', 'plain.local')
    api.state.pending = true

    await click($('#apply'))

    expect(message()).toContain('HTTPS now uses the new cert for plain.local')
    expect(message()).toContain('fully quit it and open it again')
  })

  it('says HTTPS needs a restart when the proxy reports it', async () => {
    const original = global.fetch

    global.fetch = jest.fn(async () => respond(200, { ...api.state, httpsNeedsRestart: true })) as unknown as typeof fetch
    await click($('#apply'))
    global.fetch = original

    expect(message()).toContain('Restart front-proxy to turn HTTPS on')
  })

  it('shows apply errors', async () => {
    api.failNext = { status: 500, error: "Couldn't apply the config: EACCES" }
    await click($('#apply'))

    expect(message()).toContain('EACCES')
  })

  it('reloads the state when the window gets focus, and shows HTTPS off', async () => {
    api.state = { ...api.state, https: false }

    window.dispatchEvent(new Event('focus'))
    await flush()
    await flush()

    expect($('#https-status').textContent).toBe('HTTPS off')
    expect(row('new.local').querySelector('.hint').dataset.tooltip).toMatch(/HTTPS is off/)
  })

  it('shows an error when the proxy is not reachable', async () => {
    const original = global.fetch

    global.fetch = jest.fn(async () => respond(502, {})) as unknown as typeof fetch
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    await flush()
    global.fetch = original

    expect(message()).toContain("Couldn't load the hosts: Request failed (502)")
  })
})

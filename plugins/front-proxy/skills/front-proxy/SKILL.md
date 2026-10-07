---
name: front-proxy
description: Give a local app a real-looking domain (eq. local-dev.myapp.com) and HTTPS with front-proxy, instead of localhost:3000. Use when a third-party service only accepts allowlisted domains (Stripe, Google Tag Manager, OAuth redirect URLs), an API or CORS policy blocks localhost, cookies need a real domain or subdomains, the app needs trusted HTTPS locally, or the user asks to map, proxy or point a local domain at a port.
---

# front-proxy

front-proxy maps local domains to apps on local ports for the whole OS: while it runs, it adds the domains to `/etc/hosts` (pointing at 127.0.0.1) and runs a reverse proxy on ports 80 and 443 that forwards each request to the port mapped to its `Host`. HTTPS uses locally trusted certs from mkcert. It works in every browser, curl and headless Playwright, not just one browser.

## With the MCP tools (front-proxy MCP server)

1. Call `proxy_status` to see whether the proxy runs, whether HTTPS is on and which apps are listening.
2. Call `add_host` with the domain and the app's port (eq. `local-dev.myapp.com`, `3000`). Use `update_host` to change the port of a domain that's already there, and `list_hosts` to see what's configured.
3. For HTTPS, call `generate_certs` with the domain. It needs `mkcert` installed and its local CA installed once (`mkcert -install`, which may ask for the user's password, so the user runs it in a terminal).
4. Call `apply_config` to load the changes into the running proxy, without restarting it.
5. Check the result: `proxy_status` should list the domain as `up` once the app listens on its port. Then open `http://<domain>` (or `https://`).

## What the user has to do

- **Start the proxy**: it binds ports 80/443 and edits `/etc/hosts`, so it needs sudo. Ask the user to run `front-proxy` in a terminal and keep it running. You can't start or stop it.
- **Install it**, if `front-proxy` isn't installed: `npm install -g front-proxy` (Node.js 22.12+, macOS or Linux), and `brew install mkcert` (or the mkcert install guide) for HTTPS.
- **Restart after `--no-admin`**: `apply_config` uses the proxy's admin page. If the proxy was started with `--no-admin`, the user restarts `front-proxy` to apply changes.
- **Restart for HTTPS the first time**: when `apply_config` reports `httpsNeedsRestart`, the default cert was just created and HTTPS starts after the user restarts the proxy.

## Without the MCP tools (CLI)

```bash
front-proxy add local-dev.myapp.com:3000   # map a domain to a port
front-proxy generate-certs local-dev.myapp.com   # HTTPS cert with mkcert
front-proxy list                           # configured domains
front-proxy remove local-dev.myapp.com
front-proxy                                # start the proxy (asks for the sudo password)
```

`add`, `remove` and `generate-certs` only change the config; a running proxy applies them after a restart or **Apply now** on its admin page at http://front-proxy.localhost.

## Rules

- Hosts are hostnames only (letters, digits, hyphens, dots). IP addresses, `localhost` and `front-proxy.localhost` are rejected, and so are ports 80 and 443 (the proxy's own).
- Requests for a domain that isn't configured get a 502 from the proxy.
- Don't edit `/etc/hosts` yourself: front-proxy manages its own block there while it runs.

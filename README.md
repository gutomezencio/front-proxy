<h1><img src="src/admin/favicon.svg" alt="" width="32" height="32"> front-proxy</h1>

[![npm](https://img.shields.io/npm/v/front-proxy)](https://www.npmjs.com/package/front-proxy)
[![coverage](https://codecov.io/gh/gutomezencio/front-proxy/graph/badge.svg)](https://codecov.io/gh/gutomezencio/front-proxy)
[![audit](https://github.com/gutomezencio/front-proxy/actions/workflows/audit.yml/badge.svg)](https://github.com/gutomezencio/front-proxy/actions/workflows/audit.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/gutomezencio/front-proxy/badge)](https://scorecard.dev/viewer/?uri=github.com/gutomezencio/front-proxy)
[![Socket Badge](https://badge.socket.dev/npm/package/front-proxy/0.7.1)](https://badge.socket.dev/npm/package/front-proxy/0.7.1)

Reach apps on local ports, like `localhost:3000`, through real-looking domains, like `local-dev.mylivedomain.com`, over HTTP or HTTPS.

While it runs, `front-proxy` adds your domains to `/etc/hosts`, pointing them at `127.0.0.1`, and runs a reverse proxy on ports `80` and `443`. When it stops, it removes them. The proxy reads the `Host` header of each request and forwards it to the port you mapped to that domain. HTTPS uses locally trusted certificates from [mkcert](https://github.com/FiloSottile/mkcert). Because the mapping lives in the OS, it works in every browser and tool on your machine, not just one.

```
  Browser, curl, Playwright...
          │
          │  https://local-dev.mylivedomain.com
          ▼
  ┌───────────────────────────────────────────────┐
  │ /etc/hosts                                    │
  │   127.0.0.1  local-dev.mylivedomain.com       │
  └───────────────────────────────────────────────┘
          │
          │  127.0.0.1:443  (or :80 for http)
          ▼
  ┌───────────────────────────────────────────────┐
  │ front-proxy                                   │
  │   1. TLS with the domain's mkcert certificate │
  │   2. Host header → port, from proxyHosts.json │
  │        local-dev.mylivedomain.com → 3000      │
  │      (unknown host → 502)                     │
  └───────────────────────────────────────────────┘
          │
          │  http://127.0.0.1:3000
          ▼
  Your local app
```

## Why

Some third-party services only accept requests from an allowlist of domains (Stripe and Google Tag Manager, for example), and some APIs block `localhost` with CORS. Browser extensions can fake a domain for one browser. `front-proxy` works for the whole OS, so it also covers other browsers, CLI tools and headless Playwright runs with no extra configuration.

## Requirements

- Node.js 22.12 or newer
- macOS or Linux (it edits `/etc/hosts` and uses `sudo`)
- [mkcert](https://github.com/FiloSottile/mkcert), only for HTTPS (`brew install mkcert` on macOS)

## Installation

```bash
npm install -g front-proxy
```

The `front-proxy` command is now available in your terminal.

If `npm install -g` fails with `EACCES`, your npm global folder is owned by root. That's common with the system Node on Linux or the official macOS installer. Use a Node installed with [nvm](https://github.com/nvm-sh/nvm) or Homebrew, or run `sudo npm install -g front-proxy`.

To update:

```bash
npm update -g front-proxy
```

Your domains and certificates live in `~/.front-proxy` (see [Configuration](#configuration)), so updates and reinstalls keep them.

To run it from a clone instead, see [Development](#development).

## Usage

```bash
front-proxy add local-dev.livedomain.com:3000   # map a domain to a local port
front-proxy                                     # start the proxy
```

Then open `http://local-dev.livedomain.com` (or `https://` once you've [set up certificates](#https)).

| Command                             | Description                                                          | Needs sudo |
| ----------------------------------- | -------------------------------------------------------------------- | ---------- |
| `front-proxy`                       | Start the proxy on ports `80` and `443`, adding your domains to `/etc/hosts` until it stops | Yes |
| `front-proxy --persist-hosts`       | Same, but keep the domains in `/etc/hosts` after the proxy stops (`-p` for short)          | Yes |
| `front-proxy --no-admin`            | Start without the [admin page](#admin-page)                          | Yes        |
| `front-proxy add <host:port>`       | Add a domain to the proxy config                                     | No         |
| `front-proxy remove <host>`         | Remove a domain from the proxy config                                | No         |
| `front-proxy list`                  | List the configured domains                                          | No         |
| `front-proxy generate-certs [host]` | Create HTTPS certificates with mkcert, for one domain or all of them | No         |
| `front-proxy mcp`                   | Run the [MCP server](#mcp-server) for code assistants, on stdio      | No         |
| `front-proxy --help`                | Show the help                                                        | No         |

Only starting the proxy asks for your password through `sudo`, because it binds ports `80`/`443` and edits `/etc/hosts`. The password isn't stored.

The domains go into a single block in `/etc/hosts`:

```
# <FRONT-PROXY-HOSTS>
# > local-dev.livedomain.com < Host added by front-proxy
127.0.0.1 local-dev.livedomain.com
# </FRONT-PROXY-HOSTS>
```

Stopping the proxy (Ctrl+C) removes the block, unless you started it with `--persist-hosts`. If the proxy didn't stop cleanly (it crashed or was killed), the block stays until the next start. Each start replaces any block it finds with a fresh one. `add` and `remove` only change the config, so restart the proxy to apply them.

Requests for a domain that isn't configured get a `502` response.

Hosts must be valid hostnames (letters, digits, hyphens and dots, like `myapp.local`). IP addresses, `localhost`, `front-proxy.localhost` and ports `80`/`443` (the proxy's own) are rejected. Entries in `proxyHosts.json` that don't pass these checks are skipped with a warning.

## Admin page

While the proxy runs, open [http://front-proxy.localhost](http://front-proxy.localhost) to manage your domains in the browser. The page:

- lists the configured domains, with a dot showing whether something is listening on each port
- adds and removes domains, and changes a domain's port
- shows which certificate each domain uses, with the `generate-certs` command to copy when it has none
- links to each active domain over HTTP (and HTTPS when it's on)

Changes are saved to `proxyHosts.json` right away, like the CLI commands. The page then shows a banner until they're active: click **Apply now** to reload the routes, certificates and `/etc/hosts` block without restarting, or restart `front-proxy`.

The proxy runs as root, so the page only accepts:

- requests from this machine (`127.0.0.1`/`::1`), with the `front-proxy.localhost` host, which blocks LAN clients and DNS rebinding
- changes sent from the page itself: its `Origin`, a JSON body and a random token generated each time the proxy starts

Its responses use a strict Content Security Policy and can't be framed. To turn the page off, start with `front-proxy --no-admin`.

For HTTPS on the admin page, the default certificate must include `front-proxy.localhost`. `generate-certs` adds it when it creates the default certificate. If yours was created by an older version, delete `~/.front-proxy/keys/_private-default-*.pem` and run `front-proxy generate-certs` again.

## MCP server

`front-proxy mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio, so code assistants (Claude Code, Cursor, VS Code, Windsurf…) can manage your domains for you. For example, they can map the app they just started to a domain and check that it answers.

Add it to Claude Code:

```bash
claude mcp add front-proxy -- front-proxy mcp
```

Other clients take the same command in their MCP config:

```json
{
  "mcpServers": {
    "front-proxy": { "command": "front-proxy", "args": ["mcp"] }
  }
}
```

| Tool             | What it does                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `list_hosts`     | List the configured domains, their ports and certificate status                                      |
| `add_host`       | Map a domain to a local port (same checks as `front-proxy add`)                                      |
| `update_host`    | Point a domain to another port                                                                       |
| `remove_host`    | Remove a domain                                                                                      |
| `generate_certs` | Create HTTPS certificates with mkcert, for one domain or all of them                                 |
| `proxy_status`   | Whether the proxy runs, whether HTTPS is on, whether changes are waiting, and which apps are listening |
| `apply_config`   | Load the saved config into the running proxy, like **Apply now** on the [admin page](#admin-page)    |

The MCP server runs as you, without `sudo`, like `add` and `remove`. Its changes are saved to `proxyHosts.json`. To apply them, it calls the running proxy's admin API from `127.0.0.1` with the same per-run token and `Origin` as the admin page. Some things are left to you:

- Starting and stopping the proxy needs your password, so the assistant asks you to run `front-proxy`.
- `apply_config` needs the admin page on (the default). With `--no-admin`, restart the proxy to apply changes.
- `generate_certs` can't type your password, so run `mkcert -install` once in a terminal before using it.

## HTTPS

HTTPS on port `443` needs locally trusted certificates, which `front-proxy` creates with mkcert:

```bash
front-proxy generate-certs                            # every configured domain
front-proxy generate-certs local-dev.livedomain.com   # a single domain
```

The first run installs mkcert's local CA so browsers trust the certificates. It also creates a default certificate for `localhost` and `front-proxy.localhost`. Each domain then gets its own certificate, which the proxy serves through SNI. Domains without their own certificate fall back to the default one. If there's no default certificate, the proxy starts with HTTP only.

If Chrome still says "Not secure" for a domain after its certificate was created and applied, fully quit Chrome (Cmd+Q on macOS) and open it again. Chrome remembers a certificate error it saw before, or one you clicked through, until it restarts. Firefox only trusts mkcert's CA when `nss` is installed (`brew install nss`) before running `generate-certs`.

HTTPS responses include an HSTS header (`includeSubDomains`, `preload`), so browsers remember to use HTTPS for those domains.

### Custom certificates

To use your own certificate (a wildcard, for example), save it in `~/.front-proxy/keys/` as `_private-<name>-cert.pem` and `_private-<name>-key.pem`, then set `"cert": "<name>"` on each domain that should use it:

```bash
mkcert \
  -cert-file ~/.front-proxy/keys/_private-mydomain-cert.pem \
  -key-file  ~/.front-proxy/keys/_private-mydomain-key.pem \
  "*.mydomain.com"
```

## Configuration

Domains are stored in `~/.front-proxy/proxyHosts.json` and certificates in `~/.front-proxy/keys/`. The folder is created on the first run. To keep it somewhere else, set the `FRONT_PROXY_HOME` environment variable.

The commands above manage the config, but you can also edit it by hand:

```json
{
  "local-dev.livedomain.com": {
    "port": 3000,
    "cert": "local-dev.livedomain.com"
  }
}
```

| Key    | Description                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| `port` | Local port the domain is proxied to, on `127.0.0.1`                                                                 |
| `cert` | Optional. Points to `~/.front-proxy/keys/_private-<cert>-{cert,key}.pem`. Several domains can share one certificate |

Keys starting with `$` (like the `$comment` the CLI writes) are ignored.

## Uninstalling

Stop the proxy first (Ctrl+C), so its block is removed from `/etc/hosts`. If you used `--persist-hosts`, or if an older version added your domains, start the proxy once without the flag and stop it to clean them up:

```bash
front-proxy                        # then Ctrl+C
npm uninstall -g front-proxy
rm -rf ~/.front-proxy              # config and certificates
mkcert -uninstall                  # optional: remove mkcert's local CA
```

## Development

To use `front-proxy` from a clone, or to work on it:

```bash
git clone git@github.com:gutomezencio/front-proxy.git
cd front-proxy
npm install
npm run build   # compile src/ (TypeScript) to dist/
npm link        # point the global `front-proxy` command at this clone
```

If you installed the npm package before, run `npm uninstall -g front-proxy` first so the two don't clash. `npm link` links the global command to the clone's `dist/`, so keep the folder in place and run `git pull` and `npm run build` to update. `npm unlink -g front-proxy` removes the link. The clone uses the same `~/.front-proxy` config as the npm package.

```bash
npm run build                # compile src/ to dist/ and copy the admin page's static files
npm start                    # build, then run the proxy from dist/, without the sudo wrapper
npm run dev                  # same, rebuilding and restarting on file changes
npm run start:root -- list   # build, then run through the sudo wrapper, like the installed CLI
npm run typecheck            # type-check src/ and test/
npm test                     # run the tests (Jest with ts-jest, straight from src/)
npm run test:coverage        # same, with coverage (fails below the thresholds in package.json)
npm pack --dry-run           # list the files that get published to npm
```

The code is TypeScript (strict, native ES modules) with [zod](https://zod.dev) schemas for everything it validates. `tsc` compiles it to `dist/`, and `npm pack`/`npm publish` build it first (the `prepack` script). Only `dist/`, `README.md`, `LICENSE` and `package.json` are published (the `files` field in `package.json`).

## License

MIT

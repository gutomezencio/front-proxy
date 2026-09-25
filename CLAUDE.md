# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`front-proxy` is a global CLI (`npm install -g`) that maps local domains (e.g. `local-dev.livedomain.com`) to apps running on local ports. It binds ports 80 and 443 with a `@hapi/hapi` + `@hapi/h2o2` reverse proxy and adds entries to `/etc/hosts`, so the mapping works across the whole OS rather than in a single browser.

## Commands

```bash
npm install
npm start                      # node src/proxy-server.js (run the proxy, no sudo wrapper)
npm run dev                    # same thing, under node --watch
npm run start:root             # src/start.js: re-runs proxy-server.js under sudo (like the real CLI)
npm test                       # jest, tests in test/ (npm test -- test/server.test.js for one file)

# CLI commands (same for `front-proxy`, `npm run start:root --`, or `node src/proxy-server.js`)
front-proxy add host:port
front-proxy remove host
front-proxy list
front-proxy generate-certs [host]     # needs the mkcert binary on PATH
front-proxy                           # start the servers
```

Tests use Jest in native ESM mode (`"transform": {}`, so tests import `jest` from `@jest/globals`) and cover the happy paths only. `test/server.test.js` points each `Server` at temp files by overriding `hostFilePath`, `proxyHostsPath` and `keysPath`, so it never touches `/etc/hosts` or `config/`. The proxy test uses `startServer` with a port-0 Hapi server and `server.inject`. `npm test` runs Jest with `--experimental-vm-modules`, which Jest's ESM mode requires. The repo has no linter and no build step.

## Architecture

Execution chain for the installed CLI:

1. `src/bin-running.js` (the `bin` entry) imports `./start.js`.
2. `start.js` parses the command with `cli-args.js` (so a bad command fails before the sudo prompt), then `spawn`s `proxy-server.js` with `process.execPath` and `stdio: 'inherit'`. `add`, `remove` and `start` run under `sudo`. `list` and `generate-certs` don't: mkcert must run as the user so its CA ends up in the user's CAROOT.
3. `proxy-server.js` parses the same way and dispatches to a `Server` method. `cli-args.js` defines the subcommands with yargs `.command()` in strict mode; commands are positional (`add host:port`), never `--flags`.
4. `server.js` (`Server` class) does all the work:
   - `config/proxyHosts.json` is read at runtime with `fs` (`loadProxyHosts` / `saveProxyHosts`), never `import`ed, so it stays editable at runtime. Keep it that way. It is plain JSON; keys starting with `$` (the `$comment` that `saveProxyHosts` always writes first) are ignored by `loadProxyHosts`.
   - `start()` runs HTTP on :80 and, if the default cert exists, HTTPS on :443. The catch-all route looks up the `Host` header (port stripped) in `proxyHosts` and proxies to `127.0.0.1:<port>`. Unknown hosts get a 502.
   - Per-domain TLS uses SNI. `"cert": "<name>"` on a host points to `keys/_private-<name>-{cert,key}.pem`, and `getSecureContexts()` builds one `tls.createSecureContext` per host for the `SNICallback`. Hosts without a cert use `keys/_private-default-*.pem`.
   - `generateCerts(target)` shells out to the `mkcert` binary with `execFileSync`. It runs `-install`, creates the default cert if it's missing, creates one cert per host (or for all hosts), and sets `cert` in the config.
   - `add` and `remove` edit `/etc/hosts` using a `# > host < Host added by front-proxy` marker line followed by `127.0.0.1 host`.

The package is native ESM (`"type": "module"`) and runs `src/` directly on Node 22.12+ (`engines`; there's no Babel, bundler or `dist/`). Use `import` with `.js` extensions and `import.meta.dirname` (not `require`/`__dirname`). `src/` resolves `config/` and `keys/` from `import.meta.dirname`, so it must stay a sibling of those folders. `keys/_private-*` files are gitignored. The only runtime `dependencies` are `@hapi/hapi`, `@hapi/h2o2` and `yargs`.

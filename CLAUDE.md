# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`front-proxy` is a global CLI (`npm install -g`) that maps local domains (e.g. `local-dev.livedomain.com`) to apps running on local ports. It binds ports 80 and 443 with a Hapi + h2o2 reverse proxy and adds entries to `/etc/hosts`, so the mapping works across the whole OS rather than in a single browser.

## Commands

```bash
npm install
npm start                      # babel-node src/proxy-server.js (run the proxy, no sudo wrapper)
npm run dev                    # same thing, under nodemon
npm run start:root             # src/start.js: re-runs proxy-server.js under sudo (like the real CLI)
npm run build                  # rollup -> dist/ (dist/ is committed and is what the `bin` runs)
npm test                       # jest, tests in test/ (npx jest test/server.test.js for one file)

# CLI commands (same for `front-proxy`, `npm run start:root --`, or `babel-node src/proxy-server.js`)
front-proxy add host:port
front-proxy remove host
front-proxy list
front-proxy generate-certs [host]     # needs the mkcert binary on PATH
front-proxy                           # start the servers
```

Tests use Jest (transpiled through `.babelrc` by babel-jest) and cover the happy paths only. `test/server.test.js` points each `Server` at temp files by overriding `hostFilePath`, `proxyHostsPath` and `keysPath`, so it never touches `/etc/hosts` or `config/`. The proxy test uses `startServer` with a port-0 Hapi server and `server.inject`. The repo has no linter; the eslint plugin is commented out in `build/rollup.config.js`. Rebuild `dist/` after changing `src/`, because the installed CLI only runs `dist/`.

## Architecture

Execution chain for the installed CLI:

1. `bin-running.js` (the `bin` entry, copied verbatim into `dist/`) requires `./start.js`.
2. `start.js` parses the command with `cli-args.js` (so a bad command fails before the sudo prompt), then `spawn`s `proxy-server.js` with `process.execPath` and `stdio: 'inherit'`. Under `src/` it goes through babel-node; under `dist/` it uses plain node. `add`, `remove` and `start` run under `sudo`. `list` and `generate-certs` don't: mkcert must run as the user so its CA ends up in the user's CAROOT.
3. `proxy-server.js` parses the same way and dispatches to a `Server` method. `cli-args.js` defines the subcommands with yargs `.command()` in strict mode; commands are positional (`add host:port`), never `--flags`.
4. `server.js` (`Server` class) does all the work:
   - `config/proxyHosts.json` is read at runtime with `fs` (`loadProxyHosts` / `saveProxyHosts`), never `import`ed, so rollup doesn't bundle it. Keep it that way. It is plain JSON; keys starting with `$` (the `$comment` that `saveProxyHosts` always writes first) are ignored by `loadProxyHosts`.
   - `start()` runs HTTP on :80 and, if the default cert exists, HTTPS on :443. The catch-all route looks up the `Host` header (port stripped) in `proxyHosts` and proxies to `127.0.0.1:<port>`. Unknown hosts get a 502.
   - Per-domain TLS uses SNI. `"cert": "<name>"` on a host points to `keys/_private-<name>-{cert,key}.pem`, and `getSecureContexts()` builds one `tls.createSecureContext` per host for the `SNICallback`. Hosts without a cert use `keys/_private-default-*.pem`.
   - `generateCerts(target)` shells out to the `mkcert` binary with `execFileSync`. It runs `-install`, creates the default cert if it's missing, creates one cert per host (or for all hosts), and sets `cert` in the config.
   - `add` and `remove` edit `/etc/hosts` using a `# > host < Host added by front-proxy` marker line followed by `127.0.0.1 host`.

`src/` and `dist/` resolve `config/` and `keys/` from `__dirname`, so both must stay siblings of those folders. `keys/_private-*` files are gitignored. `.babelrc` (preset-env targeting Node 12, core-js 3 `usage`, class-properties) is used by babel-node in development and by rollup for the build.

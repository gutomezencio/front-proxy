# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`front-proxy` is a global CLI (`npm install -g front-proxy`, published on npm) that maps local domains (e.g. `local-dev.livedomain.com`) to apps running on local ports. It binds ports 80 and 443 with a `@hapi/hapi` + `@hapi/h2o2` reverse proxy and, while it runs, adds entries to `/etc/hosts`, so the mapping works across the whole OS rather than in a single browser.

## Commands

```bash
npm install
npm start                      # node src/proxy-server.js (run the proxy, no sudo wrapper)
npm run dev                    # same thing, under node --watch
npm run start:root             # src/start.js: re-runs proxy-server.js under sudo (like the real CLI)
npm test                       # jest, tests in test/ (npm test -- test/server.test.js for one file)
npm run test:coverage          # same, with V8 coverage into coverage/ (CI uploads lcov.info to Codecov)

# Release (main is protected, changes go through PRs):
# 1. Run "Prepare release" (.github/workflows/prepare-release.yml) on main from the
#    Actions tab, picking patch/minor/major. It bumps the version, updates the
#    version-pinned Socket badge in README.md and opens a "Release vX.Y.Z" PR.
# 2. Approve and merge the PR. "Publish" (.github/workflows/publish.yml) then
#    publishes that version to npm via trusted publishing (keep that file name,
#    npm is configured for it) and creates the vX.Y.Z tag and GitHub release.
# Don't bump the version locally.

# CLI commands (same for `front-proxy`, `npm run start:root --`, or `node src/proxy-server.js`)
front-proxy add host:port
front-proxy remove host
front-proxy list
front-proxy generate-certs [host]     # needs the mkcert binary on PATH
front-proxy [--persist-hosts|-p]      # start the servers (-p keeps the /etc/hosts block after stopping)
```

Tests use Jest in native ESM mode (`"transform": {}`, so tests import `jest` from `@jest/globals`) and cover the happy paths only. `test/server.test.js` points each `Server` at temp files by overriding `hostFilePath`, `proxyHostsPath` and `keysPath`, so it never touches `/etc/hosts` or `~/.front-proxy`. A test also checks that `FRONT_PROXY_HOME` sets those paths. The hosts-file tests call `writeHostsFile`/`cleanHostsFile`/`stop` directly (with `process.exit` mocked). `start()` isn't tested, since it binds real ports. The proxy test uses `startServer` with a port-0 Hapi server and `server.inject`. `npm test` runs Jest with `--experimental-vm-modules`, which Jest's ESM mode requires. The repo has no linter and no build step.

## Architecture

Execution chain for the installed CLI:

1. `src/bin-running.js` (the `bin` entry) imports `./start.js`.
2. `start.js` parses the command with `cli-args.js` (so a bad command fails before the sudo prompt), then `spawn`s `proxy-server.js` with `process.execPath` and `stdio: 'inherit'`. Only `start` runs under `sudo` (it binds 80/443 and edits `/etc/hosts`). The other commands only touch the config dir and run as the user. mkcert needs that so its CA ends up in the user's CAROOT. While the child runs, `start.js` ignores SIGINT/SIGTERM/SIGHUP and waits for the child to clean up and exit. Before spawning, it creates the config dir and an empty `proxyHosts.json` as the real user, so the config stays the user's. It then passes the dir to the child as `FRONT_PROXY_HOME`: through `sudo env FRONT_PROXY_HOME=… node …` for sudo commands (sudo resets the env and `HOME`), and through `spawn`'s `env` otherwise.
3. `proxy-server.js` parses the same way and dispatches to a `Server` method. `cli-args.js` defines the subcommands with yargs `.command()` in strict mode; commands are positional (`add host:port`), never `--flags`. The one option is `--persist-hosts`/`-p`, which is only valid on the default (start) command; `start.js` forwards it to the child.
4. `server.js` (`Server` class) does all the work:
   - Config and certs live in `getConfigDir()` from `src/config-dir.js`: `$FRONT_PROXY_HOME`, or `~/.front-proxy` by default. They sit outside the package so `npm update -g` keeps them. `proxyHosts.json` is read at runtime with `fs` (`loadProxyHosts` / `saveProxyHosts`), never `import`ed, so it stays editable at runtime. Keep it that way. It is plain JSON; keys starting with `$` (the `$comment` that `saveProxyHosts` always writes first) are ignored by `loadProxyHosts`.
   - `start()` runs HTTP on :80 and, if the default cert exists, HTTPS on :443. The catch-all route looks up the `Host` header (port stripped) in `proxyHosts` and proxies to `127.0.0.1:<port>`. Unknown hosts get a 502.
   - Per-domain TLS uses SNI. `"cert": "<name>"` on a host points to `<configDir>/keys/_private-<name>-{cert,key}.pem`, and `getSecureContexts()` builds one `tls.createSecureContext` per host for the `SNICallback`. Hosts without a cert use `<configDir>/keys/_private-default-*.pem`.
   - `generateCerts(target)` shells out to the `mkcert` binary with `execFileSync`. It runs `-install`, creates the default cert if it's missing, creates one cert per host (or for all hosts), and sets `cert` in the config.
   - `add` and `remove` only edit `proxyHosts.json`; a running proxy picks the change up on restart.
   - `/etc/hosts` is only changed by `start`/`stop`. Entries live in one block between `# <FRONT-PROXY-HOSTS>` and `# </FRONT-PROXY-HOSTS>`, with a `# > host < Host added by front-proxy` headline above each `127.0.0.1 host` line. `start()` runs `cleanHostsFile()` (removes any block plus the legacy marker/entry pairs that older versions wrote outside one), binds the ports, then runs `writeHostsFile()`. A failed start cleans up and exits 1. `stop()` (on SIGINT/SIGTERM/SIGHUP) cleans the block synchronously first, unless `--persist-hosts` was passed, then stops Hapi and exits.

The package is native ESM (`"type": "module"`) and runs `src/` directly on Node 22.12+ (`engines`; there's no Babel, bundler or `dist/`). Use `import` with `.js` extensions and `import.meta.dirname` (not `require`/`__dirname`). `package.json` `files` publishes only `src/` (plus README, LICENSE and package.json). Check with `npm pack --dry-run`. The repo has no `config/` folder. The `keys/_private-*` gitignore rules remain for old clones. The only runtime `dependencies` are `@hapi/hapi`, `@hapi/h2o2` and `yargs`.

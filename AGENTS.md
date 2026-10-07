# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Cursor, Copilot, Gemini…) working in this repository. `CLAUDE.md` only imports this file, so edit this one.

## What this is

`front-proxy` is a global CLI (`npm install -g front-proxy`, published on npm) that maps local domains (e.g. `local-dev.livedomain.com`) to apps running on local ports. It binds ports 80 and 443 with a `@hapi/hapi` + `@hapi/h2o2` reverse proxy and, while it runs, adds entries to `/etc/hosts`, so the mapping works across the whole OS rather than in a single browser. `front-proxy mcp` exposes the same features to code assistants as an MCP server on stdio.

## Commands

```bash
npm install
npm run build                  # tsc -p tsconfig.build.json → dist/, plus scripts/copy-admin-assets.js
npm run typecheck              # tsc on src/ (tsconfig.json) and on test/ (test/tsconfig.json)
npm start                      # build, then node dist/proxy-server.js (run the proxy, no sudo wrapper)
npm run dev                    # build, then tsc --watch + node --watch-path=dist
npm run start:root             # build, then dist/start.js: re-runs proxy-server.js under sudo (like the real CLI)
npm test                       # jest + ts-jest, tests in test/ (npm test -- test/server.test.ts for one file)
npm run test:coverage          # same, with V8 coverage into coverage/ (CI uploads lcov.info to Codecov)
npm run build:mcpb             # build, then scripts/build-mcpb.js → front-proxy.mcpb (Claude Desktop bundle)
npm run sync-version           # copy package.json's version into server.json and the Claude Code plugin

# Release (main is protected, changes go through PRs):
# 1. Run "Prepare release" (.github/workflows/prepare-release.yml) on main from the
#    Actions tab, picking patch/minor/major. It bumps the version, runs
#    sync-version (server.json, plugin.json, the plugin's pinned npx version),
#    updates the version-pinned Socket badge in README.md and opens a
#    "Release vX.Y.Z" PR.
# 2. Approve and merge the PR. "Publish" (.github/workflows/publish.yml) then
#    publishes that version to npm via trusted publishing (keep that file name,
#    npm is configured for it) and creates the vX.Y.Z tag and GitHub release.
#    It packs the tarball once, publishes that file, builds front-proxy.mcpb, and
#    attaches both to the release with their Sigstore provenance bundle
#    (.sigstore.json). Last, it lists the version in the official MCP Registry
#    with a pinned, checksum-verified mcp-publisher (login github-oidc).
# Don't bump the version locally, and don't edit versions in server.json or
# plugins/ by hand: test/release-metadata.test.ts fails when they drift.

# CLI commands (same for `front-proxy`, `npm run start:root --`, or `node dist/proxy-server.js` after `npm run build`)
front-proxy add host:port
front-proxy remove host
front-proxy list
front-proxy generate-certs [host]     # needs the mkcert binary on PATH
front-proxy mcp                       # MCP server on stdio (src/mcp.ts)
front-proxy [--persist-hosts|-p] [--no-admin]   # start the servers (-p keeps the /etc/hosts block after stopping)
```

GitHub Actions are pinned to commit SHAs with a `# vX.Y.Z` comment, and each workflow has read-only top-level `permissions` with writes granted per job (OpenSSF Scorecard checks both). Dependabot (`.github/dependabot.yml`) keeps the pins current.

Tests are TypeScript too, run by Jest in native ESM mode through `ts-jest` (`preset: ts-jest/presets/default-esm`, transpile only since `isolatedModules` is on; `npm run typecheck` does the type checking). Tests import `jest` from `@jest/globals`; `describe`/`it`/`expect` are globals typed by `@types/jest`. `test/tsconfig.json` keeps `strict` but allows implicit `any`, so mocks and partial fixtures stay short. Imports keep `.js` extensions and `moduleNameMapper` maps them to the `.ts` files. `npm test` runs Jest with `--experimental-vm-modules`, which Jest's ESM mode requires. `coverageThreshold` in `package.json` fails the run if coverage drops below today's level: add tests with new code. The repo has no linter.

- `test/server.test.ts` and `test/server-lifecycle.test.ts` point each `Server` at temp files by overriding `hostFilePath`, `proxyHostsPath` and `keysPath`, so they never touch `/etc/hosts` or `~/.front-proxy`. `server.ports` set to `{ http: 0, https: 0 }` lets `start()` bind random ports, and `server.mkcertPath` points `generateCerts` at the fake mkcert from `test/helpers/fake-mkcert.ts` (`failFakeMkcert(bin, 'install' | 'default')` makes it fail; it uses marker files because Jest's sandboxed `process.env` doesn't reach child processes). HTTPS tests create throwaway certs with `openssl` (`test/helpers/certs.ts`). Mock `process.exit` before calling `stop()`, and remove the signal listeners `start()` adds.
- `test/hosts-validation.fuzz.test.ts` fuzzes `src/hosts-validation.ts` with `fast-check` property tests (`fc.assert(fc.property(...))`, which is also what the OpenSSF Scorecard Fuzzing check looks for), including that the zod schemas and the wrapper functions agree.
- `test/admin.test.ts` covers the admin routes with `server.inject`; `test/admin-app.test.ts` runs `src/admin/app.ts` against `index.html` in jsdom (`@jest-environment jsdom`, `jest-environment-jsdom`) with a fake `fetch`. Pure page logic lives in `src/admin/lib.ts` (unit tested in `test/admin-lib.test.ts`), so keep `app.ts` to DOM and fetch code.
- `test/release-metadata.test.ts` checks that `server.json`, the plugin manifests, the skill frontmatter and the README install links agree with `package.json` (see Distribution for agents).
- `test/mcp.test.ts` drives the MCP server with the SDK `Client` over `InMemoryTransport.createLinkedPair()` and a fake admin client; `test/admin-client.test.ts` runs the admin client against a real `Server` on a random port (admin page on and off) and against fake HTTP servers.
- The entry scripts (`bin-running.ts`, `start.ts`, `proxy-server.ts`) run on import and stay thin: CLI dispatch is in `src/commands.ts` (`runCommand`, `parseHostPort`) and the sudo/spawn arguments in `src/launcher.ts`. `test/entry-points.test.ts` imports the entry scripts with `child_process` mocked through `jest.unstable_mockModule`; `test/commands.test.ts` mocks `src/mcp.js` the same way.

## Architecture

Execution chain for the installed CLI:

1. `dist/bin-running.js` (the `bin` entry, built from `src/bin-running.ts`) imports `./start.js`.
2. `start.js` parses the command with `cli-args.ts` and builds the child command with `src/launcher.ts` (so a bad command fails before the sudo prompt), then `spawn`s `proxy-server.js` with `process.execPath` and `stdio: 'inherit'`. Only `start` runs under `sudo` (it binds 80/443 and edits `/etc/hosts`). The other commands only touch the config dir and run as the user. mkcert needs that so its CA ends up in the user's CAROOT. While the child runs, `start.js` waits for it to clean up and exit on SIGINT/SIGTERM/SIGHUP: it ignores them for the sudo child (which gets Ctrl+C itself) and passes them on to a child that runs as the user (so an MCP client stopping `front-proxy mcp` stops the server). Before spawning, it creates the config dir and an empty `proxyHosts.json` as the real user, so the config stays the user's. It then passes the dir to the child as `FRONT_PROXY_HOME`: through `sudo env FRONT_PROXY_HOME=… node …` for sudo commands (sudo resets the env and `HOME`), and through `spawn`'s `env` otherwise.
3. `proxy-server.js` parses the same way and `runCommand` (`src/commands.ts`) dispatches to a `Server` method, or to `startMcpServer` for `mcp`. `cli-args.ts` defines the subcommands with yargs `.command()` in strict mode, then checks the result with a zod schema (`ParsedCommand`); commands are positional (`add host:port`), never `--flags`. The only options are `--persist-hosts`/`-p` and `--no-admin`, both valid only on the default (start) command; `start.js` forwards them to the child.
4. `server.ts` (`Server` class) does all the work:
   - Config and certs live in `getConfigDir()` from `src/config-dir.ts`: `$FRONT_PROXY_HOME`, or `~/.front-proxy` by default. They sit outside the package so `npm update -g` keeps them. `proxyHosts.json` is read at runtime with `fs` (`loadProxyHosts` / `saveProxyHosts`), never `import`ed, so it stays editable at runtime. Keep it that way. It is plain JSON; keys starting with `$` (the `$comment` that `saveProxyHosts` always writes first) are ignored by `loadProxyHosts`.
   - `start()` runs HTTP on :80 and, if the default cert exists, HTTPS on :443. The catch-all route looks up the `Host` header (port stripped) in `proxyHosts` and proxies to `127.0.0.1:<port>`. Unknown hosts get a 502.
   - Per-domain TLS uses SNI. `"cert": "<name>"` on a host points to `<configDir>/keys/_private-<name>-{cert,key}.pem`, and `getSecureContexts()` builds one `tls.createSecureContext` per host for the `SNICallback`. Hosts without a cert use `<configDir>/keys/_private-default-*.pem`.
   - `generateCerts(target, { interactive })` shells out to the `mkcert` binary. It runs `-install`, creates the default cert if it's missing, creates one cert per host (or for all hosts), sets `cert` in the config, and returns a `CertsResult` (`created`/`failed`/`notConfigured`, or `{ ok: false, error }`). With `interactive: false` (the MCP server), `-install` runs without a terminal, so a password prompt fails fast and is reported instead of hanging.
   - `add` and `remove` only edit `proxyHosts.json`; a running proxy picks the change up on restart or through `applyConfig()` (the admin page's "Apply now").
   - `src/hosts-config.ts` holds the config changes shared by the CLI, the admin API and the MCP tools (`addHost`, `setHostPort`, `removeHost` with the 100-host limit, each reading `proxyHosts.json` fresh and returning a `ConfigChange` instead of printing), plus `getState`, `describeConfig`, `isListening` and `hostStatuses`.
   - Configured vs active hosts: `proxyHosts` is what's on disk, `activeHosts` is what the running proxy routes and wrote to `/etc/hosts`. The catch-all route reads `this.activeHosts` (with `Object.hasOwn`) and `SNICallback` reads `this.secureContexts`, so `applyConfig()` can swap both live. `startServer` falls back to `proxyHosts` when `start()` didn't set `activeHosts` (tests).
   - Validation lives in `src/hosts-validation.ts`: zod schemas (`hostSchema`, `hostInputSchema` which normalizes first, `portSchema`, `certNameSchema`, `hostEntrySchema`, and the `HostEntry`/`ProxyHosts` types inferred from them), thin wrappers that return just the message (`validateHost`, `validatePort`, `validateCertName`, `hostEntryProblem`), `parseBody` for JSON request bodies, and `adminHost`. Hosts go into `/etc/hosts` and cert names into file paths, so the CLI, the admin API, the MCP tools and `loadProxyHosts()` (which skips invalid entries with a warning) all use it. Keep the error messages in the helpers, so every caller shows the same text.
   - `/etc/hosts` is only changed by `start`/`stop` and `applyConfig()`. Entries live in one block between `# <FRONT-PROXY-HOSTS>` and `# </FRONT-PROXY-HOSTS>`, with a `# > host < Host added by front-proxy` headline above each `127.0.0.1 host` line. `start()` runs `cleanHostsFile()` (removes any block plus the legacy marker/entry pairs that older versions wrote outside one), binds the ports, then runs `writeHostsFile()`. A failed start cleans up and exits 1. `stop()` (on SIGINT/SIGTERM/SIGHUP) cleans the block synchronously first, unless `--persist-hosts` was passed, then stops Hapi and exits.

The admin page (`src/admin.ts`, `registerAdmin(hapiServer, proxy)`) is registered by `startServer` when `adminEnabled` is set (by `start()`, unless `--no-admin`). Its routes use `vhost: 'front-proxy.localhost'`, which hapi matches before the `*` catch-all. Static files come from a fixed whitelist in the `admin/` folder next to the compiled `admin.js`: `dist/admin` once built (HTML + the ES modules tsc compiles from `src/admin/*.ts` + vendored Pico CSS, no bundler; `scripts/copy-admin-assets.js` copies the non-TS files), and `src/admin` in the tests, which only fetch the HTML and CSS. Icons are Lucide SVGs inlined in `src/admin/icons.ts`, filled into `data-icon` placeholders. The browser modules must not import anything at runtime outside `src/admin/` (type-only imports are fine, they're erased), and they don't use zod; `index.html` gets a per-process token injected. A route-level `onPreAuth` guard requires a loopback `remoteAddress`. For POST/PUT/DELETE it also requires the admin `Origin`, `application/json` and the `X-Front-Proxy-Token` header, and `onPreResponse` adds CSP/framing/no-store headers. The API validates bodies with the zod schemas (`parseBody`) and makes its changes through `src/hosts-config.ts`, which reads `proxyHosts.json` fresh for every change, so CLI edits aren't overwritten. `test/admin.test.ts` covers it with `server.inject`. `writeHostsFile()` also adds the admin host while the page is on. Keep `saveProxyHosts` an in-place write: the proxy runs as root and the file must stay owned by the user.

The MCP server (`src/mcp.ts`) is `front-proxy mcp`: `@modelcontextprotocol/sdk` (stable v1, `McpServer` + `StdioServerTransport`). `createMcpServer(proxy, { adminClient })` registers the tools (`list_hosts`, `add_host`, `update_host`, `remove_host`, `generate_certs`, `proxy_status`, `apply_config`) with the zod schemas from `hosts-validation.ts` as input schemas; `startMcpServer` calls `useStderr()` first, because stdout carries the JSON-RPC messages. It runs as the user (not under sudo), so it never starts or stops the proxy and never writes `/etc/hosts`. To reach a running proxy it uses `src/admin-client.ts`: `http.request` to `127.0.0.1:80` with the admin `Host` header (fetch can't set it). `reach()` reads `/api/state` and never throws. `apply()` reads the per-run token from the admin page, then POSTs `/api/apply` with the admin `Origin`. It goes through the same guard as the browser, so don't loosen the admin checks for it.

All user-facing output goes through `src/output.ts` (`success`/`error`/`warn`/`info` with a title plus indented detail lines, `colors`, and a braille `spinner` for async work). It uses plain ANSI codes with no color dependency. Colors and the spinner animation turn off when stdout isn't a TTY or `NO_COLOR` is set (`FORCE_COLOR` forces colors), so tests and piped output stay plain text. `useStderr()` sends everything to stderr and turns the animation off (the MCP server). Use `blankLine()` instead of `console.log('')`. `mkcert -install` runs without a spinner because it can prompt for a password.

The package is TypeScript compiled to native ESM (`"type": "module"`, `module: NodeNext`, `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`) and runs from `dist/` on Node 22.12+ (`engines`). There's no Babel or bundler, only `tsc`, and `dist/` is gitignored. TypeScript is pinned to 6.x because ts-jest doesn't support TypeScript 7 yet. Use `import` with `.js` extensions (even for `.ts` files), `import type` for type-only imports, and `import.meta.dirname` (not `require`/`__dirname`). Paths resolved from `import.meta.dirname` must work from both `src/` (tests) and `dist/` (the package), so keep `src/` and `dist/` mirror images. `package.json` `files` publishes only `dist/` (plus README, LICENSE and package.json), and `prepack` builds it, so `npm pack`/`publish.yml` always ship a fresh build. Check with `npm pack --dry-run`. The repo has no `config/` folder. The `keys/_private-*` gitignore rules remain for old clones. The runtime `dependencies` are `@hapi/hapi`, `@hapi/h2o2`, `yargs`, `zod` and `@modelcontextprotocol/sdk`.

## Distribution for agents

front-proxy is listed where code assistants look for MCP servers. `package.json` is the source of truth for the name, description and version:

- **MCP Registry**: `server.json` (schema `2025-12-11`; `description` max 100 chars) describes the npm package run as `npx front-proxy mcp`. The registry checks ownership through `mcpName` (`io.github.gutomezencio/front-proxy`) in the published `package.json`. Check it with `mcp-publisher validate`.
- **Claude Code plugin**: `.claude-plugin/marketplace.json` (this repo is the marketplace) lists `plugins/front-proxy/`. That folder holds `.claude-plugin/plugin.json`, `.mcp.json` (runs `npx -y front-proxy@<version> mcp`) and `skills/front-proxy/SKILL.md`, the skill that tells agents when and how to use front-proxy. The plugin lives in a subfolder so the repo's `CLAUDE.md` isn't part of it. Check both with `claude plugin validate .` and `claude plugin validate ./plugins/front-proxy`. Keep the skill in step with the MCP tools and the CLI.
- **Claude Desktop bundle**: `scripts/build-mcpb.js` stages `dist/`, production `node_modules`, `LICENSE` and `assets/icon.png` in `mcpb/` (gitignored). It generates `manifest.json` from `package.json`, reading the tool list from `createMcpServer` over an in-memory client. Then it runs `mcpb validate` and `mcpb pack` into `front-proxy.mcpb` (gitignored). CI builds it on every push.
- **README install links**: the Cursor (`cursor.com/install-mcp`, base64 config), VS Code (`vscode.dev/redirect`, URL-encoded config) and `.mcpb` download links. `test/release-metadata.test.ts` decodes them and checks they run the same command as the plugin.

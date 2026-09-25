# front-proxy

Map local domains (like `local-dev.livedomain.com`) to apps running on local ports, at the OS level.

`front-proxy` runs a reverse proxy on ports `80` and `443` and adds your domains to `/etc/hosts`. Every browser and tool on your machine then reaches your local app through the real-looking domain.

## Why

Some third-party services only accept requests from an allowlist of domains (Stripe and Google Tag Manager, for example), and some APIs block `localhost` with CORS. Browser extensions can fake a domain for one browser. `front-proxy` works for the whole OS, so it also covers other browsers, CLI tools and headless Playwright runs with no extra configuration.

## Requirements

- Node.js 22.12 or newer
- macOS or Linux (it edits `/etc/hosts` and uses `sudo`)
- [mkcert](https://github.com/FiloSottile/mkcert), only for HTTPS (`brew install mkcert` on macOS)

## Installation

```bash
git clone git@github.com:gutomezencio/front-proxy.git
cd front-proxy
npm install
// Install it as a package on your machine
npm install -g .
```

The `front-proxy` command is now available in your terminal. It's linked to the clone, so keep the folder in place. To update, run `git pull` and then `npm install`.

## Usage

```bash
front-proxy add local-dev.livedomain.com:3000   # map a domain to a local port
front-proxy                                     # start the proxy
```

Then open `http://local-dev.livedomain.com` (or `https://` once you've [set up certificates](#https)).

| Command                             | Description                                                          | Needs sudo |
| ----------------------------------- | -------------------------------------------------------------------- | ---------- |
| `front-proxy`                       | Start the proxy on ports `80` and `443`                              | Yes        |
| `front-proxy add <host:port>`       | Add a domain to `/etc/hosts` and the proxy config                    | Yes        |
| `front-proxy remove <host>`         | Remove a domain from `/etc/hosts` and the proxy config               | Yes        |
| `front-proxy list`                  | List the configured domains                                          | No         |
| `front-proxy generate-certs [host]` | Create HTTPS certificates with mkcert, for one domain or all of them | No         |
| `front-proxy --help`                | Show the help                                                        | No         |

Commands that edit `/etc/hosts` or bind ports `80`/`443` ask for your password through `sudo`. The password isn't stored.

Requests for a domain that isn't configured get a `502` response.

## HTTPS

HTTPS on port `443` needs locally trusted certificates, which `front-proxy` creates with mkcert:

```bash
front-proxy generate-certs                            # every configured domain
front-proxy generate-certs local-dev.livedomain.com   # a single domain
```

The first run installs mkcert's local CA so browsers trust the certificates. It also creates a default certificate for `localhost`. Each domain then gets its own certificate, which the proxy serves through SNI. Domains without their own certificate fall back to the default one. If there's no default certificate, the proxy starts with HTTP only.

HTTPS responses include an HSTS header (`includeSubDomains`, `preload`), so browsers remember to use HTTPS for those domains.

### Custom certificates

To use your own certificate (a wildcard, for example), save it in `keys/` as `_private-<name>-cert.pem` and `_private-<name>-key.pem`, then set `"cert": "<name>"` on each domain that should use it:

```bash
mkcert \
  -cert-file keys/_private-mydomain-cert.pem \
  -key-file  keys/_private-mydomain-key.pem \
  "*.mydomain.com"
```

## Configuration

Domains are stored in `config/proxyHosts.json` and certificates in `keys/`. `npm install -g .` links the global command to your clone, so both folders live in the cloned repo. The commands above manage the config, but you can also edit it by hand:

```json
{
  "local-dev.livedomain.com": {
    "port": 3000,
    "cert": "local-dev.livedomain.com"
  }
}
```

| Key    | Description                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------- |
| `port` | Local port the domain is proxied to, on `127.0.0.1`                                                  |
| `cert` | Optional. Points to `keys/_private-<cert>-{cert,key}.pem`. Several domains can share one certificate |

Keys starting with `$` (like the `$comment` the CLI writes) are ignored.

## Development

```bash
npm install
npm start                    # run the proxy from src/, without the sudo wrapper
npm run dev                  # same, restarting on file changes
npm run start:root -- list   # run through the sudo wrapper, like the installed CLI
npm test                     # run the tests
```

The code is plain ES modules and runs directly, with no build step.

## License

MIT

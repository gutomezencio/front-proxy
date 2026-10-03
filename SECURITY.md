# Security policy

## Supported versions

Only the latest release on [npm](https://www.npmjs.com/package/front-proxy) gets security fixes. Upgrade with `npm install -g front-proxy@latest` before reporting.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub: [open a security advisory](https://github.com/gutomezencio/front-proxy/security/advisories/new).

Include:

- the front-proxy version (`npm ls -g front-proxy`), Node version and OS
- what an attacker can do, and what they need to have or control first
- steps or a proof of concept to reproduce it

You'll get a reply within 7 days. Once a fix is released, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Sensitive areas

`front-proxy start` runs as root, so these matter most:

- `/etc/hosts` edits: anything that could write lines other than the front-proxy block
- the config and certs in `~/.front-proxy` (or `$FRONT_PROXY_HOME`): file paths, ownership and permissions
- the admin page on `front-proxy.localhost`: requests from other sites or non-loopback clients that get through its checks
- the reverse proxy on ports 80 and 443: routing a request somewhere other than the mapped `127.0.0.1` port

## Verifying a release

npm packages are published from GitHub Actions with [trusted publishing](https://docs.npmjs.com/trusted-publishers), so they carry npm provenance:

```bash
npm audit signatures
```

Each [GitHub release](https://github.com/gutomezencio/front-proxy/releases) also has the published tarball and its Sigstore bundle (`.sigstore.json`). To check a downloaded tarball:

```bash
gh attestation verify front-proxy-X.Y.Z.tgz --repo gutomezencio/front-proxy
```

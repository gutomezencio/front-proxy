# Front-Proxy

Proxy for dynamic handle of local domains usage for front-end applications running locally on different ports.

### How it works?

A Node.js server will connect into your local `80` and `443` ports, making a proxy forward of the requests from specified local domains (like from `local-dev.livedomain.com`) to local apps running on specified ports.
That is useful when working with third-party services which only accepts requests from allowed domain list, like Stripe, GTM and also to workaround CORS protection when requesting an API.

There are some alternatives to do it on a browser level, however, front-proxy handles it on a OS level, allowing you to use your apps in different browsers and applications, and for instance making the path clear for a playwright chrome browser test running without any configuration tweak.

### Setup:

1. Install the dependencies by running `npm install`.
2. Add it to your global packages, by running `npm install -g`
3. Done! Now you can run it by the `front-proxy` command on your terminal

### Usage:

- #### Add a domain to the proxy list:

```bash
front-proxy --add local-dev.livedomain.com:3000
```

- #### Remove a domain from the proxy list:

```bash
front-proxy --remove local-dev.livedomain.com:3000
```

- #### List the domains in the proxy list:

```bash
front-proxy --list
```

- #### Run the proxy server:

```bash
front-proxy
```

### 80 Port access

Considering the `80` port is protect by default on a OS level, `front-proxy` will prompt your sudo password (it won't be stored) to be able to intercept requests from the `80` port and also to update your `hosts` file by automatically adding your custom local domains there.

### Local development & workspace running:

Just run `npm start` and it will behave the same as running the `front-proxy` command directly

### HTTPS certificates

HTTPS on port `443` needs locally trusted certificates. `front-proxy` creates them with [mkcert](https://github.com/filosottile/mkcert), so install it first (`brew install mkcert` on macOS, or follow the instructions in their repo).

- #### Generate certs for every configured domain:

```bash
front-proxy --generate-certs
```

- #### Generate a cert for a single domain:

```bash
front-proxy --generate-certs local-dev.livedomain.com
```

The command runs `mkcert -install` once, so browsers trust the local CA. Then it writes `keys/_private-<domain>-cert.pem` and `keys/_private-<domain>-key.pem` and sets a `cert` key on that domain in `config/proxyHosts.json`:

```json
{
  "local-dev.livedomain.com": {
    "port": 3000,
    "cert": "local-dev.livedomain.com"
  }
}
```

`cert` holds the `<name>` part of `keys/_private-<name>-{cert,key}.pem`, so you can point several domains at the same cert (a wildcard cert, for example). It also creates a default cert (`keys/_private-default-*.pem`, for `localhost`) the first time. Domains without a `cert` key use the default cert. If there is no default cert, the proxy starts on HTTP only.

To make a cert by hand (a wildcard, for example), use the same naming and set `cert` to `<name>`:

```bash
mkcert \
  -cert-file keys/_private-mydomain-cert.pem \
  -key-file  keys/_private-mydomain-key.pem \
  "*.mydomain.com"
```

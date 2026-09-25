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

### Self-signed certificate for HTTPS requests

To use HTTPS locally it requires a self-signed certificate. That will be used to handle access in the `443` port.

You can use [mkcert](https://github.com/filosottile/mkcert) to generate your self-signed certificate. You can install it by following the instructions from their GitHub repo https://github.com/filosottile/mkcert.

Replace the `[my-domain]` and `mydomain.com` placeholders by the wanted local domain.

```bash
mkcert \
  -cert-file keys/_private-[my-domain]-cert.pem \
  -key-file  keys/_private-[my-domain]-key.pem \
  "*.mydomain.com" \
  localhost \
  127.0.0.1 \
  ::1
```

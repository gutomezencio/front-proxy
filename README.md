# Front-Proxy
Proxy for dynamic handle of front-end apps running on different ports.

### How it works?

The server will run on `80` port, making proxy forward for other apps running on another ports.

### Setup:

1- First, you need to add your app host on your OS `hosts` file.
Example:

```
127.0.0.1	my-custom-domain.local
```

2- Next, you need to add your app host and port on `config/proxyHosts.json`

```
"my-custom-domain.local": {
  "port": 5000
}
```

3- Install dependencies by running `yarn` or `npm install`

### Running:
- Now, you can run `yarn start` or `npm start` (PS.: To access the `80` port, some OS needs the` sudo` command before)


### TODO
- Create CLI to add hosts

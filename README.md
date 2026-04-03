# @cdxoo/npm-lockdown-proxy

A minimal npm registry proxy that blocks any package (or version) not on a whitelist.

## AI Disclosure

This stuff was vibe coded with claude (pronounced "KLORT!!"). I hope I never have to actually mantain this...

## Run

```sh
# env var defaults are PORT=4873 WHITELIST=whitelist.json 
npx @cdxoo/npm-lockdown-proxy 

# or

npm install -g @cdxoo/npm-lockdown-proxy
npm-lockdown-proxy
npm-lockdown-proxy-whitelist-from-lockfile some-package-lock.json [--merge]

```

## Use

```sh
npm install <pkg> --registry http://localhost:4873
# or
echo "registry=http://localhost:4873" >> my-project/.npmrc # or ~/.npmrc
# or
npm config set registry http://localhost:4873

# if you previously installed a version of the same package that is not whitelisted
# you may hit the local npm cache which will make it fail in this case install with
npm install --cache /dev/null ...
# or clear the local cache with
npm cache clean --force
```

## Server Env Vars

| Env var | Default | Description |
|---|---|---|
| `PORT` | `4873` | Port to listen on |
| `WHITELIST` | `whitelist.json` | Path to whitelist file |

## Whitelist format

`whitelist.json` is an object. The value controls which versions are allowed:

```json
{
  "express":        "*",
  "lodash":         "4.17.21",
  "@types/node":    ["18.19.9", "20.11.5"],
  "@cdxoo/dbscan":  "min-age 30 days",
  "axios":          ["1.6.0", "min-age 14 days"]
}
```

| Value | Meaning |
|---|---|
| `"*"` | Any version |
| `"1.2.3"` | Exact version only |
| `["1.2.3", "4.5.6"]` | Any of these exact versions |
| `"min-age N days"` | Any version published at least N days ago |
| `["1.2.3", "min-age N days"]` | Exact version, or any version at least N days old |

`min-age` rules affect both package discovery and tarball downloads. When npm resolves a package without an explicit version, the manifest it receives will only list versions that satisfy the age requirement — newer versions are invisible to the resolver.

## Behaviour

- Package not in whitelist -> `404` (npm sees it as non-existent)
- Package in whitelist, version not allowed -> `404` on the tarball download
- Applies to **all** packages including transitive dependencies
- `/-/` endpoints (ping, search) are always passed through

## Reload whitelist without restart

```sh
kill -HUP <pid>
```

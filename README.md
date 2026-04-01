# npm-lockdown-proxy

A minimal npm registry proxy that blocks any package (or version) not on a whitelist.

## Run

```sh
node proxy.js
```

| Env var | Default | Description |
|---|---|---|
| `PORT` | `4873` | Port to listen on |
| `WHITELIST` | `whitelist.json` | Path to whitelist file |

## Use

```sh
npm install <pkg> --registry http://localhost:4873
# or set it globally
npm config set registry http://localhost:4873
```

## Whitelist format

`whitelist.json` is an object. The value controls which versions are allowed:

```json
{
  "express":      "*",
  "lodash":       "4.17.21",
  "@types/node":  ["18.19.9", "20.11.5"]
}
```

| Value | Meaning |
|---|---|
| `"*"` | Any version |
| `"1.2.3"` | Exact version only |
| `["1.2.3", "4.5.6"]` | Any of these exact versions |

## Behaviour

- Package not in whitelist -> `404` (npm sees it as non-existent)
- Package in whitelist, version not allowed -> `404` on the tarball download
- Applies to **all** packages including transitive dependencies
- `/-/` endpoints (ping, search) are always passed through

## Reload whitelist without restart

```sh
kill -HUP <pid>
```

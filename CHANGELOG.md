# Changelog

## [Unreleased]

### Fixed

- `whitelist-from-lockfile.js` was missing from the `files` array in `package.json` and would not be included in the published npm tarball, making the `npm-lockdown-proxy-whitelist-from-lockfile` binary unavailable after install
- Tarball requests where the filename does not match the expected `<pkg>-<version>.tgz` pattern no longer silently bypass version enforcement — they are now blocked with a 404
- `isMetadata` could incorrectly be set to `true` for a tarball request with an unparseable filename, potentially triggering manifest filtering on a non-metadata response
- `filterManifest` would throw on malformed or unexpected upstream JSON, crashing the request handler — it now returns the raw body unchanged if parsing fails

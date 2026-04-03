# Changelog

## [Unreleased]

### Added

- `min-age N days` whitelist rule: allows any version of a package that was published at least N days ago. Can be used standalone (`"min-age 30 days"`) or combined with exact versions (`["1.2.3", "min-age 30 days"]`). Applies to both manifest filtering (package discovery) and individual tarball requests.
- Global `"*"` whitelist key: a `min-age` rule assigned to the `"*"` key acts as a fallback for any package not explicitly listed. Per-package entries always take precedence.

- `whitelist-from-lockfile`: versions within each package entry are now sorted lowest to highest in the serialized output

### Fixed

- `whitelist-from-lockfile.js` was missing from the `files` array in `package.json` and would not be included in the published npm tarball, making the `npm-lockdown-proxy-whitelist-from-lockfile` binary unavailable after install
- Tarball requests where the filename does not match the expected `<pkg>-<version>.tgz` pattern no longer silently bypass version enforcement — they are now blocked with a 404
- `isMetadata` could incorrectly be set to `true` for a tarball request with an unparseable filename, potentially triggering manifest filtering on a non-metadata response
- `filterManifest` would throw on malformed or unexpected upstream JSON, crashing the request handler — it now returns the raw body unchanged if parsing fails

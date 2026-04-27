# Changelog

All notable changes to fleet will be documented here.

## Unreleased

### Changed

- `fleet-main` is no longer a magic container. The gateway no longer falls back to a
  literal `fleet-main` container when no feature is active. Requests arriving with no
  active feature now receive an HTTP 503 response with a helpful HTML page pointing at
  the dashboard (`localhost:4000`). The old implicit dependency on a running
  `fleet-main` container is removed; spin up an explicit feature with `fleet add <name>`
  instead.

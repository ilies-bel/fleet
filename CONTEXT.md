# Project Context

Canonical domain terms for this project. Edited via `mars glossary`.

## Language

**active feature**:
The single feature whose instance is currently routed to the stable preview port (localhost:3000); at most one is active at a time, and the gateway is the source of truth.

**feature**:
A reviewable branch of the app at a defined version (its own git worktree), shown as one card in the Fleet dashboard. Its running container is an instance.
_Avoid_: app, application

**instance**:
A running container hosting the full app at a feature's defined version. Named like app-<feature> (e.g. app-bd-app-3s9 runs feature bd-app-3s9). A feature has at most one instance.

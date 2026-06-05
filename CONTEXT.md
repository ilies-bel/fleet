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

**operation**:
A bounded gateway action on an instance — build, sync, activate, stop, or remove — with a start, an end, and an outcome (success or failure); the unit a Fleet log page is scoped to.
_Avoid_: run, workflow_run

**failure-reason clustering**:
Grouping of failed operations by their curated reason code, so repeated failures of the same cause surface as one cluster rather than many separate entries in the Fleet log UI.

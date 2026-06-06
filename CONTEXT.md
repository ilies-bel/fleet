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

**review note**:
An improvement jotted against the active feature while previewing it: a captured CSS selector (or none) plus free text, scoped to a feature and the page route it was captured on, persisted client-side until the operator deletes it.
_Avoid_: annotation, comment

**capture mode**:
A dashboard preview state in which clicks inside the previewed app are intercepted to record an element's selector as a review note instead of driving the app; off by default, marked on-screen, toggled from the UI or a keyboard shortcut.
_Avoid_: picker mode, inspect mode

**feature diff**:
The set of changes in a feature's branch relative to main (git diff main...HEAD), computed read-only against the feature's own git metadata and shown in the dashboard DIFF tab.
_Avoid_: patch, changeset

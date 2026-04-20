# Vision

Fleet exists to make reviewing feature branches feel as natural as opening a new browser tab.

## Philosophy

### Streamline the development cycle

Switching between feature branches should not require stopping a server, checking out code, rebuilding, and reconfiguring. Fleet eliminates that context-switching tax by keeping every branch alive simultaneously. A developer can move from one feature to the next in a single click, without touching the terminal.

The review loop shrinks from minutes to seconds.

### Minimize friction

Every interaction is designed around the path of least resistance:

- One command to initialize (`fleet init`)
- One command to add a branch (`fleet add`)
- One URL to review it (`localhost:3000`)
- One dashboard to manage everything (`localhost:4000`)

No credentials to rotate for OAuth — register a single callback URL once and forget it. No port juggling — one stable port always points at whatever is active. No surprises — if a container is still building, the logs tell you exactly where it is.

### Use established tools

Fleet is built on tools every developer already has installed: Docker, bash, and Node. There is no proprietary runtime, no custom daemon, no background service to babysit.

Docker handles isolation and build reproducibility. A reverse proxy handles routing. A Vite dev server handles the dashboard. These are solved problems — Fleet does not reinvent them, it composes them.

## What this is not

Fleet is not a staging environment. It is not a CI runner. It is not a team-shared service.

It is a local developer tool, deliberately scoped to one machine. Keeping it local keeps it fast, keeps it simple, and keeps it under the developer's full control.

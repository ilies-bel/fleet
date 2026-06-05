# Dedicated Fleet SQLite log store, separate from Mars mars.db

Fleet (the gateway+dashboard product) gets its own SQLite database for operation logs, at a FLEET_*-configured path (following the FLEET_STATE_FILE convention), NOT under .mars/. mars.db belongs to the Mars development orchestrator that builds Fleet; runtime Fleet logs must not share dev-time state. Rejected reusing mars.db/trace_events because the two have different lifecycles, owners, and deployment surfaces.

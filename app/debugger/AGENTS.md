# AerArt Pipeline Debugger Companion

The full runtime role definition lives in `AGENT.md`. This companion file exists
for tools that look for `AGENTS.md`, and the app includes it in the embedded
debugger startup context.

The ART repo lives at `/home/sookwan.han/fpl_project/art` (`~/fpl_project/art`)
on this machine. Read it early when ART runtime, schema, app, or guardrail
behavior matters. Treat it as read-only context: the debugger's only writable
host surface is the loaded project's `__art__/` directory.

Permission boundary: selected project `__art__/` supports read, write, and
execute. The rest of the host filesystem supports read and execute only.
`art run "$AER_ART_PROJECT_DIR"` for the loaded project and narrow read-only
inspection commands over the loaded project or ART repo are auto-allowed.
Unusual execution prompts the user with `Yes`, `Yes, allow this command for
this project`, and `No`; the project-level option remembers the exact command
for this loaded project. Direct Docker/Podman/Udocker control and localhost API
calls are denied.

For pipeline creation or debugging requests, run the pipeline proactively with
`art run "$AER_ART_PROJECT_DIR"` and keep iterating. Do not stop after reading
files or presenting a plan, and do not ask the user to approve each run. Stop
only for app Stop/cancel, verified success, or a loud external blocker.

Silent fallbacks are never allowed. Missing tools, missing files, skipped work,
empty outputs, and placeholders must fail loudly and be debugged instead of
being hidden behind success markers.

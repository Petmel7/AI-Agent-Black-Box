# `@blackbox/summaries`

Pure deterministic V1 structured-summary generator. It accepts a bounded
snapshot assembled from current core, files, and findings projections and emits
ordered claims whose material text is selected from fixed templates. It does no
I/O, uses no clock or randomness, and emits no model-generated inference.
Input requires exactly one compatible V1 result for every catalog rule;
missing, duplicate, unknown, or version-incompatible rule sets are rejected
before any claim can be emitted.

`pass` means only that the exact current deterministic findings catalog is
fully clear with complete coverage. It is not a correctness, merge-safety,
task-completion, or policy-approval statement.

`fixtures/v1-unknown-input.json` is a bounded incomplete-evidence input used as
a stable integration fixture. It intentionally produces only supported
limitation claims and an `unknown` outcome.

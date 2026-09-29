# BBX-007: Git Before/After Evidence

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-006C completed at `bd033b6eb0fa6e1e4bd9fd0b9f11b03cf6ea70e2`
- **Architecture:** Accepted ADR-0002, ADR-0006, ADR-0007, and ADR-0008

## Goal

Capture consistent, redacted Git evidence before and after the wrapped process,
preserve the pre-existing dirty state, and emit an uncertainty-aware comparison
without modifying the repository or replacing the child outcome when final Git
capture degrades.

## Context

Use the canonical contracts in `packages/contracts/src/evidence/events.ts`, the
collector durability/redaction boundaries completed by BBX-006A, and the
wrapped lifecycle completed by BBX-006C. ADR-0008 defines the Git observation
and attribution semantics for this task.

The existing `observeGitDiffCaptured()` byte-injection seam is scaffolding, not
the approved public capture boundary. Git evidence must be produced by the
collector-owned Git reader and committed through `CollectorSession` ownership.

## In Scope

- Read-only discovery and validation of one local Git worktree.
- Bounded `before`, `after`, and caller-requested `checkpoint` snapshots.
- Redacted deterministic status, comparison, and file-list artifacts.
- One before/after `git.diff.captured` event with explicit attribution labels.
- Integration with wrapped child launch, close, signal, warning, and delivery
  ordering.
- Cross-platform deterministic tests using temporary local repositories.

## Out of Scope

- GitHub, remotes, fetch/pull/push, PRs, CI evidence, branches created by the
  collector, or repository provisioning.
- Commits, checkout, staging, stash, clean, reset, submodule recursion, worktree
  creation, repository repair, or any source/repository mutation.
- Codex telemetry and checkpoints scheduled from provider events; BBX-008 owns
  those integrations.
- Backend projections, file-change tables, findings, summaries, dashboard, or
  causal `agent-created` claims.
- A new evidence schema version, new event kinds, package split, production
  dependency, native Git library, or database migration.

## Required Changes

### Collector-owned Git boundary

- Add a small CLI-local Git reader invoked with direct argument arrays and no
  shell. It must implement ADR-0008 command hardening, output/time/entry bounds,
  repository-root validation, and stable machine-readable parsing.
- Discover the worktree from the wrapped process's initial working directory.
  If `BLACKBOX_REPOSITORY_ROOT` is configured, require its canonical path to
  match the discovered root. Reject bare and non-repository inputs before spawn;
  support attached, detached, worktree, and unborn-HEAD states.
- Do not follow symlinks or recurse into submodules, nested repositories, or
  ignored files. Never pass a repository-controlled path as an option.
- Disable Git behavior that can prompt, page, contact a network, acquire
  optional locks, invoke external diff/textconv/fsmonitor helpers, or run shell
  interpretation. Treat malformed, excessive, timed-out, or signalled output as
  collection failure with stable safe errors.

### Snapshot and artifact persistence

- Add a `CollectorSession` snapshot API that accepts only phase plus bounded
  collector-owned options; callers cannot inject canonical events, artifact
  references, redaction claims, snapshot IDs, timestamps, counts, Git output,
  or repository paths.
- Replace or narrow the existing public arbitrary-byte Git-diff seam. The Git
  reader must be the only production source of Git snapshot/diff bytes.
- Emit `git.snapshot.captured` with collector-owned identity, `source.component`
  set to `git`, the observed HEAD when available, exact dirty/count metadata,
  and a required immutable status artifact.
- Define and document version 1 deterministic JSON formats for status and file
  list artifacts, including schema version, ordering, attribution enum, safe
  redacted display paths, ambiguity/unavailability reasons, and repository/HEAD
  state. Do not persist absolute paths, Git-directory paths, storage paths, raw
  object locations, or unredacted raw path bytes.
- Persist comparison evidence as a bounded post-redaction artifact. Preserve
  before and final Git-native patch evidence, staged/unstaged distinctions,
  binary/unavailable metadata, and untracked additions where safely available.
- Commit artifact bytes, declarations, links, and each event atomically under
  the current run owner. Failure leaves no partial canonical evidence.

### Consistency and attribution

- Bracket each snapshot with HEAD and porcelain-state observations. Retry one
  inconsistent capture within the same original time/size bounds; fail rather
  than publish a snapshot from continuously changing state.
- Compare snapshot manifests by exact internal entry identity. The public file
  list must classify each relevant entry as `pre-existing`,
  `observed-during-run`, `mixed-or-uncertain`, or `unavailable` according to
  ADR-0008. Never label a change as child- or agent-caused.
- Preserve renames, additions, deletions, staged-only, unstaged-only, combined
  staged/unstaged, type changes, executable-bit changes, symlink state, binary
  metadata, submodule gitlinks, and untracked entries when Git exposes them.
- Emit optional `filesChanged`, `linesAdded`, and `linesDeleted` only from
  complete evidence with documented counting semantics; otherwise omit them.
- Link the comparison to the exact immutable before/after snapshot IDs. Never
  regenerate content under an existing snapshot, diff, event, or artifact ID.

### Wrapped lifecycle composition

- Preserve the BBX-006C order and child-result isolation while composing:
  `run.started → before snapshot → spawn → actual close → after snapshot →
comparison → run.finished → close → optional run-scoped delivery`.
- A before-snapshot failure prevents spawn, attempts a failed terminal event and
  safe closure, returns the existing collector failure result, and exposes no
  raw Git error or path.
- An after/comparison failure emits the existing coalesced content-free warning,
  omits unsupported Git evidence, still attempts the real child terminal event,
  and preserves the child's exact exit or supported signal result.
- After actual signal termination, bounded local Git finalization is allowed,
  but BBX-006C's prohibition on remote drain remains unchanged.
- Checkpoint capture is a bounded reusable collector operation for BBX-008. This
  task does not call it automatically while the child runs.

### Documentation

- Document Git prerequisites, supported repository states, artifact formats,
  limits, attribution meanings, failure behavior, privacy boundary, and the fact
  that temporal observation is not causal proof.
- Update the CLI recovery/operator documentation only where Git capture creates
  new visible incomplete or orphan states.

## Acceptance Criteria

- A clean, dirty, staged, unstaged, untracked, renamed, deleted, binary, and
  mixed-state temporary repository produces valid immutable v1 snapshot and
  diff events with correct snapshot linkage and deterministic artifacts.
- Pre-existing unchanged dirty entries remain `pre-existing`; clean-before
  entries changed afterward are `observed-during-run`; dirty entries changed
  again and other ambiguous cases are `mixed-or-uncertain`.
- Repeated capture of the same unchanged state yields semantically identical
  manifests apart from collector identity/time, with stable ordering on Windows
  and POSIX.
- Detached HEAD, unborn HEAD, linked worktree, spaces, leading dashes, rename
  paths, symlinks where supported, and submodule gitlinks fail safely or produce
  the documented representation without command injection or traversal.
- A configured/discovered root mismatch, bare/non-repository input, missing Git,
  hostile external diff/textconv/fsmonitor configuration, malformed output,
  timeout, output overflow, quota exhaustion, and continuously changing state
  cannot create false or partial Git evidence.
- Before failure prevents child launch. After/comparison failure cannot replace
  the real child exit/signal result, duplicate terminal evidence, enable a
  signal-path drain, or leak listeners/resources.
- Git capture causes no tracked, untracked, index, ref, object, config, hook,
  worktree, or submodule mutation. Only external spool state may change.
- Sentinel secrets and private absolute paths are absent from SQLite, WAL/SHM,
  temporary/final artifacts, batches, diagnostics, warnings, stdout, and stderr.
- Concurrent capture/read races are detected within bounds and result in one
  consistent observation or explicit absence, never a fabricated mixture.
- Existing delivery identity, lease, retry, redaction, sealing, wrapped-process,
  exit, signal, and offline behavior remains compatible.
- No dependency, lockfile, canonical contract, Prisma migration, backend, or
  later-roadmap behavior changes.

## Required Tests

- Unit tests for porcelain parsing, deterministic sorting/serialization,
  attribution classification, count semantics, bounds, safe errors, and command
  construction with adversarial paths/configuration.
- Temporary-repository integration tests covering the repository states and
  transitions in the acceptance criteria, including byte-identical artifact
  retry behavior and no repository mutation.
- Lifecycle tests covering pre-launch failure, normal/non-zero exit, spawn
  failure, signal close, final-capture failure, warning coalescing, cleanup,
  sequence ordering, and delivery gating.
- Race tests that mutate HEAD/index/worktree between bracket observations and
  prove bounded retry/fail-closed behavior without timing-dependent sleeps.
- Security tests that scan every durable/output surface for configured sentinel
  values and prove external helpers, prompts, pagers, hooks, and shell syntax are
  not executed.
- Public-surface tests proving callers cannot inject Git bytes, identities,
  counts, redaction metadata, timestamps, paths, or arbitrary canonical events.

## Validation

Run focused checks while editing. Because this task changes evidence integrity,
redaction, filesystem/process interaction, and lifecycle ordering, run the full
deterministic local gate once on the final state:

```text
pnpm install --frozen-lockfile
pnpm --filter @blackbox/cli test
pnpm format:check
pnpm lint --force
pnpm typecheck --force
pnpm test --force
pnpm build --force
git diff --check
git status --short --untracked-files=all
```

PostgreSQL/Supabase, Docker, network, and hosted Git provider access are not
required. Tests must use isolated local temporary repositories and the installed
Git executable. Do not install dependencies or access a network without
separate explicit authorization.

## Deliverables

- CLI-local hardened Git reader and deterministic parsers/serializers.
- CollectorSession-owned snapshot/comparison persistence boundary.
- Wrapped lifecycle integration and recovery-safe behavior.
- Versioned Git artifact-format and operator documentation.
- Focused and full regression evidence in the implementation report.

## Referenced Decisions and Documents

- `AGENTS.md`
- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/evidence-model.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/decisions/ADR-0002-canonical-evidence-envelope.md`
- `docs/architecture/decisions/ADR-0006-local-spool-and-delivery-state.md`
- `docs/architecture/decisions/ADR-0007-collector-redaction-and-bounded-capture.md`
- `docs/architecture/decisions/ADR-0008-local-git-evidence-and-attribution.md`
- `docs/tasks/BBX-006C-wrapped-process-and-recovery.md`
- `docs/review-guidelines.md`

## Risks

- Git state is not transactionally readable; bracketed verification reduces but
  cannot eliminate external mutation uncertainty.
- Git configuration, filters, unusual filenames, symlinks, worktrees, and
  platform path semantics create command-injection and privacy hazards.
- Large/binary/untracked content may exceed safe bounds and produce incomplete
  textual comparison evidence.
- Redaction can alter patch line counts or make display paths collide; counts
  and attribution must remain conservative.
- Temporal observation cannot prove the wrapped child caused a change.

## Open Questions

None. Material changes to canonical Git events, causal attribution, repository
mutation, provider checkpoints, or backend file projections require a new or
amended approved architecture decision.

# ADR-0008: Local Git Evidence and Attribution

- **Status:** Accepted
- **Date:** 2026-09-29
- **Decision owners:** Project architecture

## Context

The v0.1 collector must preserve the repository state observed before and after
the wrapped process, including a pre-existing dirty worktree, without modifying
the repository or claiming causality that Git cannot prove. Git paths and diff
content may contain secrets, repository state may change while it is inspected,
and user Git configuration may invoke external programs. These are evidence
integrity and security guarantees shared by later projections and findings.

The canonical version 1 contract already defines `git.snapshot.captured` and
`git.diff.captured`. This decision defines how the local collector produces
those events; it does not change their wire schema.

## Decision

### Repository and execution boundary

The collector invokes the installed Git executable directly with an argument
array and `shell: false`. It never fetches, checks out, stages, commits, stashes,
cleans, resets, updates submodules, writes refs, or intentionally writes Git
objects. Commands are local and read-only, use bounded execution time and
bounded output, disable pagers, prompts, optional locks, external diff drivers,
text conversion, and filesystem monitors, and do not interpret repository paths
as command options.

Before the child starts, Git must resolve one non-bare worktree from the child's
initial working directory. A configured repository root must resolve to that
same worktree root. Worktrees and detached HEAD are supported. An unborn branch
is represented without a HEAD commit. A missing Git executable, non-repository,
bare repository, root mismatch, unsafe path, timeout, or malformed Git response
is a visible pre-launch collection failure and prevents child launch.

Ignored files are excluded. Submodules and nested repositories are not recursed
into; their containing repository records only the Git-observable entry state.
Symlinks are inspected as links and are never followed by snapshot content
capture.

### Snapshot protocol

Each successful observation creates a collector-owned UUID and one immutable
`git.snapshot.captured` event with phase `before`, `after`, or `checkpoint`.
The event records the observed HEAD commit when available, dirty state, staged,
unstaged, and untracked counts, and a required post-redaction status artifact.

The status artifact is a versioned deterministic JSON manifest derived from
Git porcelain output. Entries are sorted deterministically and describe the
index/worktree status, entry kind, rename relationship when available, and a
redacted display path. Internal raw path bytes may be used transiently to keep
before/after identity exact, but raw unredacted paths, absolute repository
paths, Git-directory paths, and local object locations are never persisted.
Ambiguous redacted path collisions remain distinct by collector-owned opaque
entry identity and are labeled as ambiguous for display.

Snapshot capture brackets its reads with HEAD and porcelain-state checks. If
the observed state changes during capture, the collector retries once within
the original bound. A continuously changing state is unavailable rather than a
fabricated atomic snapshot. A successful event therefore represents one
internally consistent observation interval, not a filesystem transaction.

### Before/after comparison and attribution

After two successful snapshots, the collector may emit one
`git.diff.captured` event linking their immutable snapshot IDs. Its required
artifacts are:

- a post-redaction comparison artifact containing bounded Git-native patch
  evidence for the before and after states, with metadata-only records for
  binary or unavailable content; and
- a deterministic versioned JSON file list describing the state transition for
  each relevant entry.

The file list is the authoritative attribution surface. It distinguishes:

- `pre-existing`: dirty before and unchanged afterward;
- `observed-during-run`: clean or absent before and changed afterward;
- `mixed-or-uncertain`: dirty before and changed again, repository identity or
  HEAD changed, concurrent mutation was detected, or the available evidence
  cannot isolate one transition; and
- `unavailable`: an entry could not be inspected safely within the bounds.

“Observed during run” is temporal evidence, not proof that the child caused the
change. The collector never emits an `agent-caused` claim. Optional file and
line counts are emitted only when they can be computed from complete captured
evidence; otherwise they are omitted.

The comparison preserves both the baseline dirty evidence and final Git state.
It must not simplify the final patch by subtracting text patches in a way that
loses staged/unstaged distinctions or misattributes a file that was already
dirty.

### Lifecycle and failure isolation

The wrapped lifecycle records `run.started`, then the `before` snapshot, before
spawning the child. On actual child close it attempts the `after` snapshot and
before/after comparison before `run.finished` and run closure. Checkpoints use
the same snapshot protocol but are requested only through a bounded
collector-owned API; BBX-007 does not schedule provider checkpoints.

A failed before snapshot prevents launch and is recorded as a collector
failure when ownership permits. A failed after snapshot or comparison emits a
content-free warning, omits the unsupported Git event, and never replaces the
child's real exit or signal result. Signal termination still permits bounded
local final Git capture but never enables the remote drain prohibited by
ADR-0006. Delivery begins only after all attempted local final evidence and the
terminal run event are durable.

### Redaction, bounds, and durability

All persisted status, path, patch, and file-list bytes pass through the existing
collector redaction and immutable artifact boundary before event commit. Hashes
and byte lengths refer to those post-redaction bytes. Git output, file content,
entry count, per-entry reads, total artifact bytes, command duration, and retry
count are bounded by collector-owned constants and the existing spool quota.

Snapshot events, their referenced artifacts, and diff events commit through the
existing run-ownership, sequence, artifact-link, and sealing invariants. A
partial capture cannot leave a canonical event referring to missing or mutable
bytes. Temporary comparison material lives outside the repository and follows
the spool's crash-visible orphan rules.

## Consequences

- v0.1 can distinguish preserved pre-existing evidence from changes observed
  during the wrapped interval without overstating causality.
- The collector remains offline-capable and does not require Git hosting or a
  GitHub integration.
- Continuously changing repositories, binary files, submodules, unusual paths,
  and bounded-output failures may yield explicit uncertainty rather than a
  complete textual diff.
- Later projections and findings must consume the attribution labels and must
  not infer stronger causality from event ordering alone.
- Git implementation details remain collector-local; no new package or service
  boundary is established by this decision.

## Alternatives Considered

### Treat the final diff as wholly agent-authored

Rejected because it misattributes pre-existing or concurrent changes.

### Stash or commit the initial worktree

Rejected because evidence collection must not modify the developer's repository
or refs and may not be recoverable after interruption.

### Build temporary Git trees inside the repository object database

Rejected for v0.1 because it writes repository metadata and may invoke filters.

### Copy the complete repository before launch

Rejected because it is unbounded, duplicates ignored or sensitive content, and
does not scale to ordinary repositories.

### Defer attribution entirely to backend analysis

Rejected because only the local collector can safely observe and redact the
ephemeral before/after worktree states.

## Follow-up

BBX-007 implements this protocol. BBX-009 builds projections from its events,
and BBX-010 consumes the explicit attribution and uncertainty labels. A future
schema version may add first-class structured attribution fields after the v0.1
artifact format is proven.

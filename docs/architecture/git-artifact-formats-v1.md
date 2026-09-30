# Local Git artifact formats version 1

BBX-007 records local Git observations as deterministic UTF-8 JSON artifacts.
Every artifact ends with one newline, uses the fixed property order emitted by
the collector, and is redacted before its first spool write. Absolute worktree,
Git-directory, object-storage, and spool paths are never fields in these
formats.

## Status manifest

The `git-status` artifact has `schemaVersion: 1`, its collector-owned
`snapshotId`, the `before`, `after`, or `checkpoint` phase, repository HEAD
state (`attached`, `detached`, or `unborn`), and an ordered `entries` array.
HEAD commit and branch are present only when observable. An ordered `headTree`
array records the bounded immutable tree entry identity, redacted display path,
mode, object ID, and blob/gitlink type used for later HEAD-delta comparison.
HEAD-tree paths that redact to the same display value retain distinct opaque
identities and carry `displayAmbiguous: true` plus
`displayReason: "redaction-collision"`.

Entries are ordered by the exact transient Git path bytes after strict UTF-8
decoding. Each entry contains an opaque identity, redacted display path,
ordinary/rename-or-copy/unmerged/untracked kind, index and worktree status,
submodule status, and available mode metadata. A rename includes its redacted
original display path. Binary and unavailable metadata are explicit. Distinct
paths that redact to the same display value remain separate and carry
`displayAmbiguous: true`.

## Comparison artifact

The `git-diff` artifact has `schemaVersion: 1`, a collector-owned `diffId`, the
exact before/after snapshot IDs, and separate before and after evidence. Each
side preserves Git-native staged and unstaged binary-capable patches.
Untracked regular UTF-8 files are included only within the file and total
capture bounds; NUL-containing, invalid UTF-8, oversized, unsafe, or unreadable
entries are binary or unavailable metadata-only. The `headDelta` section binds
the exact before/after commits to an ordered tree delta and a hardened,
binary-capable commit patch when a commit transition exists. Files changed only
by a clean-to-clean HEAD transition therefore remain visible even when both
porcelain manifests are empty. The tree delta is derived from bounded
machine-readable rename-aware Git output; a committed rename is represented as
one transition with original and final opaque identities. For unborn-to-HEAD
and HEAD-to-unborn transitions, the collector derives the repository's empty
tree identity with non-writing `hash-object` and compares the complete final or
initial tree rather than one commit's parent delta. The collector never follows
a symlink or descends into a submodule or nested repository.

Comparison serialization performs an additional collision pass across every
before/after transition endpoint. A redacted display shared by multiple opaque
identities is marked ambiguous on the HEAD delta and file-list transition and
on both rename sides. Repeated endpoints with the same opaque identity, such as
an ordinary modification, do not create a false collision. Snapshot artifacts
remain immutable; these annotations exist only in comparison artifacts.

## File-list artifact

The `git-file-list` artifact has `schemaVersion: 1`, the diff and snapshot IDs,
`attributionIsTemporalNotCausal: true`, and an ordered `files` array. Each file
contains before/after status metadata and exactly one attribution:

- `pre-existing`: dirty before and unchanged afterward;
- `observed-during-run`: absent from the dirty-before manifest and dirty after;
- `mixed-or-uncertain`: pre-existing state changed again, HEAD changed, or the
  transition cannot be isolated;
- `unavailable`: bounded safe inspection did not produce enough evidence.

“Observed during run” is temporal evidence. It does not prove that the wrapped
child or an agent caused the change.

## Bounds and consistency

Each Git command has a 5-second limit. Repository discovery has a 10-second
deadline, and both attempts of one snapshot share a separate 10-second capture
deadline. Command output is limited to 8,000,000 bytes,
manifests to 10,000 entries, safely inspected regular files to 1,000,000 bytes
each and 4,000,000 bytes total, decoded paths to 32,768 bytes, and each
serialized artifact to 20,000,000
bytes. A snapshot compares two complete observations of HEAD, the HEAD tree,
porcelain bytes, staged and unstaged patches, and content-sensitive entry
fingerprints. It retries the complete observation once within the original
deadline and otherwise fails closed. Optional line counts are omitted because
redaction and incomplete binary/untracked evidence make them unsafe to claim.

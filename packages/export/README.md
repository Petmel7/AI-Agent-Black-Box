# `@blackbox/export`

Pure Export V1 contract, canonical encoder, builder, parser, and integrity
digest for one AI Agent Black Box run. The package has no framework, database,
storage, filesystem, network, clock, or randomness dependency.

## Public contract

Export V1 uses media type
`application/vnd.ai-agent-black-box.evidence-export.v1+json`. The top-level
`format` is `evidence-export` and `formatVersion` is `1`. Schemas are strict:
unknown properties, versions, enum values, malformed identities, incompatible
derived-state graphs, duplicate identities, and noncanonical collection order
are rejected.

The bundle contains canonical repository/run identities, immutable canonical
events with safe receipt time, artifact declarations and verification metadata,
current compatible core/files/findings/summary state, independent outcomes,
and explicit limitations. Unavailable sections carry one of `missing`,
`processing`, `stale`, `incomplete`, or `failed`. An observed `unknown` outcome
is a value and is never collapsed into missing data.

Artifact declarations include post-redaction byte length and SHA-256 plus
redaction, compression, and encoding metadata. Artifact bytes, bucket names,
object keys, signed URLs, and other storage capabilities are forbidden.

## Canonical bytes and integrity

`buildEvidenceExportV1` first validates and normalizes database-order-dependent
arrays. Object keys are sorted by their UTF-8 bytes; arrays retain their
documented contract order; numbers are non-negative safe integers; strings use
JSON escaping; and no insignificant whitespace or byte-order mark is emitted.
The digest is lowercase SHA-256 over the exact emitted UTF-8 bytes.

`parseEvidenceExportV1` independently validates UTF-8, strict schemas,
cross-section compatibility, collection order, exact canonical bytes, the
total byte ceiling, and the digest. Noncanonical whitespace and duplicate JSON
keys fail because their input bytes cannot equal the canonical re-encoding.

The digest is an integrity/replay identity. It is not a signature,
attestation, proof of server identity, correctness certificate, merge approval,
or policy decision.

## V1 bounds

The named public constants are exported as `EVIDENCE_EXPORT_V1_LIMITS`.

| Collection                                                      |                                                            Maximum |
| --------------------------------------------------------------- | -----------------------------------------------------------------: |
| Immutable events                                                |                                                             20,000 |
| Artifact records                                                |                                                             40,000 |
| Event-to-artifact declaration links (total)                     |                                                             40,000 |
| Core completeness reasons                                       |                                                                100 |
| Commands, tools, tests, Git snapshots, Git diffs, errors, usage |                                                        20,000 each |
| File entries                                                    |                                                             20,000 |
| Findings                                                        | 100 (the complete nine-rule V1 catalog is required when available) |
| Reason codes, matches, and references per finding               |                                                           100 each |
| Summary claims                                                  |                                                                100 |
| Supports per claim                                              |                                                                100 |
| Derived limitations                                             |                                                                 32 |
| Canonical UTF-8 bundle                                          |                                                             16 MiB |

Exceeding a collection or byte bound fails the whole build with the stable
`export_too_large` code. Export V1 never truncates a collection. Existing
source-level omission or truncation remains explicit in canonical evidence and
the limitations list.

The fixed limitations state that artifact bytes are excluded and that the
bundle is not a signature, correctness certificate, merge approval, compliance
export, or full artifact archive.

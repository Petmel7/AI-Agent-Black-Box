# Deterministic analyzers

`@blackbox/analyzers` is the pure, versioned BBX-010 analyzer boundary. V1
consumes only bounded current `core` and verified `files` projection facts. It
does no I/O and does not inspect patch text, prompts, raw output, or provider
payloads.

Path classification normalizes only `\\` to `/` and ASCII `A-Z` to lowercase.
Both current and original redacted display paths are classified for rename-aware
rules; ambiguous or unavailable path evidence remains partial or unknown. A
deleted related-test path is never positive test evidence, and incomplete core
evidence prevents the production-without-test rule from clearing or triggering
with complete coverage.
Sensitive categories are authentication/authorization, payments,
infrastructure/deployment, migrations, secret/config material, and dependency
manifests. Production/test correspondence is a fixed basename relation after
removing conventional test suffixes and source/test directory segments.
Lockfiles correspond only to the manifest(s) in their documented ecosystem:
`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, and `pnpm-lock.yaml` to
`package.json`; `poetry.lock` to `pyproject.toml`; `Pipfile.lock` to `Pipfile`;
`Cargo.lock` to `Cargo.toml`; `Gemfile.lock` to `Gemfile`; and `go.sum` to
`go.mod`.

Every rule returns one bounded aggregate result. Matches and references are
sorted and capped; truncation is explicit. Unsupported evidence is represented
as `unknown`, never as a pass. Result identity hashes the organization-scoped
canonical run identity, so identical collector run UUIDs in different tenants
cannot collide.

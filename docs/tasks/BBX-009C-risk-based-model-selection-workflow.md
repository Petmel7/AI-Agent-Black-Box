# BBX-009C: Risk-Based Model Selection Workflow

- **Status:** Done
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-009B completed at `63fcfa8b490f732de3b42730c035c36817225418`
- **Delivery risk:** Low
- **Execution profile:** Standard
- **Architecture:** No ADR required; this changes repository workflow guidance only and does not alter product, data, trust, or runtime boundaries.

## Goal

Require architecture to assess delivery risk before approval and recommend an
appropriate model/reasoning level for architecture, implementation, and review,
without pretending the repository can inspect or change Codex UI settings.

## In Scope

- Add one canonical risk-to-execution-profile matrix to `docs/tasks/README.md`.
- Add a concise model-selection responsibility to `AGENTS.md`.
- Update the three BBX workflow Skills with role-specific behavior.
- Add `Delivery risk` and `Execution profile` to new task specifications.
- Produce a compact model recommendation before implementation and review
  handoffs, and repeat it when discovered risk changes materially.

## Out of Scope

- Product code, dependencies, lockfile, CI, scripts, hooks, plugins, automation,
  model APIs, budgets, or Codex UI configuration.
- Automatic model switching or verification of the model selected in an
  existing task.
- Retroactive edits to completed or already approved task specifications.
- Treating model choice as a substitute for tests, evidence, independent review,
  or user authorization.

## Required Behavior

### Stable risk classes

Use four durable classes:

- **Low:** documentation or narrow mechanical changes with no runtime contract.
- **Standard:** bounded application behavior with ordinary failure impact.
- **High:** migrations, evidence integrity, authentication, tenant isolation,
  secrets, concurrency, leases, retries, crash windows, public contracts,
  external protocols, or broad cross-package behavior.
- **Critical:** credible data-loss, security, irreversible, destructive, or
  governance impact where a defect can escape ordinary recovery boundaries.

Architecture records the applicable triggers and chooses the highest class
present. If implementation or review discovers a higher-risk boundary, it must
report the change and recommend escalation rather than silently continuing under
the lower profile.

### Current advisory mapping

Document this mapping as current guidance, not a permanent product contract:

| Execution profile | Architect            | Implementation              | Review               |
| ----------------- | -------------------- | --------------------------- | -------------------- |
| Low               | GPT-5.6 Sol / Medium | GPT-5.6 Sol / Low or Medium | GPT-5.6 Sol / Medium |
| Standard          | GPT-5.6 Sol / Medium | GPT-5.6 Sol / Medium        | GPT-5.6 Sol / High   |
| High              | GPT-5.6 Sol / High   | GPT-5.6 Sol / High          | GPT-5.6 Sol / XHigh  |
| Critical          | GPT-5.6 Sol / XHigh  | GPT-5.6 Sol / XHigh         | GPT-5.6 Sol / XHigh  |

`Max` is never a default. Recommend it only as a targeted escalation for an
exceptionally ambiguous boundary or after at least two unresolved review/fix
cycles on the same root problem.

The durable task fields are the risk class and execution profile. Exact model
names are advisory and may be updated later without rewriting historical tasks.

### Role behavior

- Architect assesses risk before requesting task approval and emits:

  ```text
  Model recommendation
  Complexity: <Low | Standard | High | Critical>
  Risk triggers: <concise reasons>
  Architect: <model / reasoning>
  Implementation: <model / reasoning>
  Review: <model / reasoning>
  Escalation: <none or condition>
  ```

- Architect must not claim it changed an existing task's model. The user changes
  it manually unless task creation is explicitly delegated with model settings.
- Implementation and Review read the declared profile, briefly report a known
  mismatch, and follow the approved scope. A mismatch alone does not block an
  otherwise authorized task.
- Review remains independent and should use the assurance level in the matrix;
  no profile weakens review, evidence, or validation requirements.

## Acceptance Criteria

- `docs/tasks/README.md` contains the single canonical matrix and recommendation
  template.
- `AGENTS.md` references the workflow concisely without duplicating the matrix.
- `$bbx-architect`, `$bbx-implement`, and `$bbx-review` preserve their existing
  gates and add only their role-specific responsibilities.
- New task specifications require `Delivery risk` and `Execution profile`; old
  task files remain unchanged.
- Guidance clearly distinguishes advisory model selection from enforceable task,
  validation, authorization, and review gates.
- Skills contain no machine-specific paths, branches, commit SHAs, credentials,
  or hard-coded current task/thread identifiers.
- No runtime, product, dependency, lockfile, CI, ADR, or tooling behavior changes.

## Validation

```text
pnpm format:check
git diff --check
git status --short --untracked-files=all
```

Inspect the complete diff and verify exact scope: `AGENTS.md`,
`docs/tasks/README.md`, the three BBX `SKILL.md` files, and this task status.
No lint, typecheck, test, build, database, Docker, or network run is required.

## Deliverables

- Canonical risk/profile guidance and recommendation template.
- Updated role instructions in the three repository workflow Skills.

## Risks

- Model names can become stale; mitigate by labeling the mapping advisory while
  keeping risk classes stable.
- Excessive escalation can waste usage; mitigate with explicit triggers and a
  restricted `Max` rule.
- Agents cannot reliably inspect UI-selected settings; require honest mismatch
  reporting rather than inferred verification.

## Open Questions

None.

## Implementation Prompt

```text
$bbx-implement docs/tasks/BBX-009C-risk-based-model-selection-workflow.md
Implement only the Approved documentation and workflow-skill changes. Preserve every existing approval, review, authorization, validation, and finalization gate. Run the focused documentation validation and stop before commit.
```

## Review Prompt

```text
$bbx-review docs/tasks/BBX-009C-risk-based-model-selection-workflow.md
Independently review the complete documentation-only diff. Verify the risk mapping, advisory-versus-enforceable boundary, role behavior, exact file scope, and preservation of all existing workflow gates. Do not edit or finalize.
```

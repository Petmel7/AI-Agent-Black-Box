---
name: bbx-review
description: Independently review an AI Agent Black Box diff or commit against an Approved task and its evidence; use for read-only verification and a PASS or NEEDS FIXES verdict, not for implementation or fixes.
---

# Independently Review AI Agent Black Box Work

Review the declared diff or commit without modifying it.

## Establish review inputs

1. Identify the approved task, base branch or commit, exact diff or commit under review, referenced ADRs and contracts, and recorded validation results.
2. Read `AGENTS.md`, the approved task, only its referenced architecture documents, and `docs/review-guidelines.md`.
3. Treat the repository sources identified by `AGENTS.md` and the approved task as authoritative. If this guidance conflicts with a higher-priority source, stop and report the conflict.
4. Report unavailable inputs as validation gaps; do not infer them.

## Review independently

- Inspect the complete diff and trace relevant behavior. Do not treat the implementation report as proof.
- Reproduce important validation where practical and tie claims to the state on which commands actually completed.
- Prioritize correctness, evidence integrity, tenant isolation, secret safety, idempotency, migration risk, contract compatibility, and missing behavioral tests.
- Remain read-only. Do not fix files unless the user separately requests and authorizes a fix task.
- On repeat review, audit every earlier finding and state whether it is resolved, remains open, or cannot be verified.

## Report the verdict

Write the review report and any review handoff prompt in English. Follow the finding format in `docs/review-guidelines.md`. Every actionable finding must include:

- priority and concise title;
- precise file location;
- concrete trigger or failure scenario and impact;
- the protection or evidence that is missing;
- the smallest safe correction.

Separate actionable findings from residual risks and validation gaps. If there are no actionable findings, state `No actionable findings.` explicitly. End with exactly one verdict: `PASS` or `NEEDS FIXES`.

Never commit, push, change task status, or modify reviewed files.

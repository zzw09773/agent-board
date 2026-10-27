# Required merge checks and audit

An approval alone no longer makes `agent-board/approved` green. All four gates
must refer to the same full commit SHA:

1. The configured required CI check runs succeeded on GitHub.
2. The task reviewer (Dot in the operating setup) approved the current PR head.
3. An independent QA identity (the Opus QA session in the operating setup) passed QA.
4. A release authority explicitly released that SHA.

## Configuration

Deployment owners must supply these non-secret variables in their own deployment
configuration. This change does not create or modify any deployment configuration
or credentials.

| Variable | Meaning |
|---|---|
| `APPROVERS`, `DEFAULT_REVIEWER` | Existing review authority and task reviewer; configure Dot as both. |
| `QA_REVIEWERS` | Comma-separated authenticated identities assigned to Opus QA. No default. |
| `RELEASE_APPROVERS` | Comma-separated identities authorized to release. No default. |
| `REQUIRED_CI_CHECKS` | Nonempty JSON array, e.g. `[{"name":"CI","app_id":15368}]`. Check names and GitHub App IDs must match the actual CI provider. |

The repository now supplies a GitHub Actions job named `CI`. Confirm its App ID
for the target GitHub installation before configuring the required checks. Only
check runs from each configured App count: similarly named runs from another App,
plain commit statuses, missing or truncated results, pending runs, failed runs,
and `neutral`/`skipped` runs cannot release a task. The board's own check cannot
count as CI. GitHub credentials must allow reading PRs and check runs; the existing
App's Checks read/write permission also permits delivery of the board check.

Missing GitHub binding, CI configuration, QA identity or release identity blocks
release or merge. Standalone boards may still review tasks but cannot mark them
merged without the gates. Existing approvals lack QA/release and therefore need
fresh attestations. Existing task history is preserved; old actors/timestamps are
not reconstructed as new audit evidence. Startup requeues previously green
checks that no longer satisfy the gates and restores the outbox alarm.

GitHub branch protection/rulesets must require **both** the actual CI checks and
`agent-board/approved`, with each check pinned to its expected App. Disable bypass
where enforcement is required. A token-only integration verifies the task table
but cannot publish the trusted board check. This PR does not change repository
rulesets, deployment settings or secrets.

## Calls

After Dot sets `task_update {id, status:"approved", head_sha}`, QA calls:

```json
{"id":"T-001","kind":"qa","head_sha":"<full reviewed SHA>","passed":true}
```

using `task_attest`. The release authority then uses the same tool with
`kind:"release"`. Release verifies required CI and reads the current open PR head
from GitHub before saving. `passed:false` revokes a gate. The owner cannot attest
either gate, and the reviewer cannot attest QA. QA attestations always clear any
earlier release, so QA reruns require another explicit release.

Returning to review clears approval, QA and release. Changing owner, reviewer,
linked PR or other protected scope while approved requires returning to review
first. New PR commits need a new approval and attestations. Merge recording still
requires a non-owner merger, the approved head SHA, a matching merged PR, QA,
release and a fresh successful CI query. The merge commit itself cannot substitute
for an unreviewed PR head.

## Audit and concurrency

`task_get` returns `audit`: append-only events with `id`, `actor`, UTC `at`,
`action`, full `sha` and details (including CI run IDs for release/merge). Review,
QA, release, revocation and merge events are retained in SQLite independently of
the task's current status. Page beyond 50 events with `before_audit_id` set to
`next_audit_before`. Rejected calls add no audit events.

The task row, history, audit and check-outbox generation are written in one
Durable Object SQLite transaction. After an external GitHub read, a monotonic
revision check rejects concurrent changes, including a return to the same SHA.
Mainline lock and permission invariants are checked again inside the transaction.
Multiple runners remain clients of that one authority; their local cursor/alert
files are not approval or release evidence and are not changed by this feature.

## Limits

The board authenticates identities, not the model behind a session. Operators must
bind `QA_REVIEWERS` to the intended Opus session. The PR supplies the gate protocol;
it does not assert that Opus QA or a release happened for this PR.

GitHub reads and SQLite writes are separate systems. A PR or CI rerun can change
after verification; require native GitHub CI checks and merge an exact reviewed
SHA. Outbox delivery remains asynchronous: after a revocation an earlier green
check can remain on GitHub until the replacement arrives. Before merging, require
`github_check.pending:false`, no delivery error, and matching `delivered`/`desired`,
and re-read current gates. There is no webhook or continuous CI polling in this
change. Audit records are append-only through MCP, not tamper-proof against an
administrator with direct database access.

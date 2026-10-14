# Proposed operator actions

The action panel is disabled by default. Enable it only by editing
`src/github/action-config.json` on the repository's default branch: set
`operator`, `planner`, `tracker` (`OWNER/REPO`), and an explicit
`repositories` allowlist. `project` is a ProjectV2 node ID, or empty to
disable project-field actions. No dispatcher or proposal can widen this
configuration. The allowlist should start with the forge-native repositories;
upstreams require an operator-reviewed configuration change.

This prevents a proposal from borrowing the viewer's token to write outside
the approved repositories. Only the configured operator can execute, using
the existing browser GitHub client and their own token. Only comments by the
operator or planner count; edited comments require a named, trusted last
editor, matching agent-board's job-plan rule.

## Provisional contract

As of 2026-10-14, agent-board#71 has not published its schema or fixtures on
the default branch. `operator-action.schema.json` and the synthetic fixture
in `test/fixtures/operator-action.json` are provisional, based on tracker#582.
Reconcile the contract with agent-board before enabling the panel. The shared
schema is vendored here so the parser has a versioned contract, not an
undocumented collection of API calls.

A comment holds exactly one unquoted, column-zero fenced block with the info
string `agent-board-action`. Its object has `schema` equal to
`agent-board/operator-action/v1`, a one-line `title`, `why`, and 1–20 `actions`.
Every action has `type`, `repo`, `number` and `updatedAt` (the target issue API's
UTC timestamp). Unknown properties are refused, and a target may occur only
once.

An action may not target its containing proposal issue or use it as the
destination parent: reservation changes that issue's timestamp. Put such a
proposal on a different issue instead; rejection happens before reservation.

Mutation-specific fields are defined in the schema:

- `close_issue` takes a `reason` comment; `reopen_issue` takes no extra fields.
- `add_label` and `remove_label` take `label` and require it absent/present.
- `approve_pr` and `merge_pr` take the exact `head` SHA. Merge also takes
  `method` (`merge`, `squash`, `rebase`). Only open, non-draft PRs qualify.
- `set_project_field` takes `field` (`Priority` or `Status`), `from` (option
  name or null), and `value` (option name). The project comes from config;
  field, option and item IDs are resolved live, never from the proposal.
- `add_sub_issue` and `move_sub_issue` take the destination `parent` target
  including its `updatedAt`, and `previousParent` (null for add, `OWNER/REPO#N`
  for move). Moving uses GitHub's single replace-parent operation.

## Reads, execution and failure

The closed panel does no reads. Load proposals explicitly reads the 20 most
recently updated open tracker issues and at most 100 comments per issue.
Older proposals are outside this window; an issue with more comments is
refused rather than executed with unread receipts, with a warning that does
not hide valid proposals from other issues. There is no background
polling. Targets and exact mutation payloads are shown as plain text, wrapping
at phone width. Any failed or stale target check disables the batch.

Execution re-reads the authenticated viewer, proposal and every target before
reserving the batch, then checks each target again just before its action.
The result comment starts with
`<!-- agent-board-action-executed: COMMENT-ID@UPDATED-AT -->`.
It is posted **before** mutations and updated with numbered results afterward.
All later actions are skipped at the first failure. A reservation counts as
executed even if interrupted, so reload cannot replay a partially successful
batch. Check targets manually and write a new proposal with fresh preconditions
to recover. A lost receipt response may have created the receipt; a lost write
response may have performed the action. The UI never automatically retries.

Receipts count only from trusted writers with a trusted last editor. The first
receipt wins after a bounded re-read, as in job-plan dispatch. GitHub comments
are not an atomic lock: concurrent clients depend on GitHub showing earlier
receipts. Do not execute the same proposal from multiple tabs/devices. Deleting
a receipt can permit replay. Editing a proposal creates a new version.

GitHub offers no compare-and-swap for issue, label, project-field or sub-issue
writes, so a change racing the final read remains possible. PR merge uses the
server-side SHA guard; approval is explicitly bound to the reviewed SHA.
Closing has two writes (reason comment then state); if the second fails, the
reason may already exist and the receipt says failed or uncertain. This panel
does not implement rollback, tailnet changes, or live write tests against real
repositories.

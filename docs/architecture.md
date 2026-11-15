# Architecture and coverage

## Runtime flow

1. Next.js validates the session, organization membership and workspace role, then runs scoped queries in a PostgreSQL transaction. A transaction-local tenant identity drives row-level policies.
2. Publishing adds an immutable rule version. The scheduler leases due routes. A background worker leases each job with PostgreSQL SKIP LOCKED and a token. Advisory locks serialize rule runs.
3. Adapters read scoped provider records or use a validated saved evidence input. Evaluation emits pass, fail or unknown. Findings use a stable logical key. Each recurrence has its own occurrence ID and history.
4. A transaction stores results, evidence, run state, and outbox intents. Provider errors and limits leave coverage incomplete. Exports and configured emails run through worker jobs.
5. Reviewers acknowledge, assign, record comments, suppress, or dismiss findings in RelayProof. Healthy observations can resolve an occurrence with evidence. Operator mutations use optimistic versions.

The app uses bounded scans and run checkpoints. Live Jira reads the configured project in full under its cap. ServiceNow uses a bounded incident lookback and fixed scan upper bound. The reconciliation adapter distinguishes failed scope access from an observed absence within approved visibility. A known Jira sample allows the worker to verify project and field visibility each run. Provider indexing and ACLs still limit the observations. Baseline output marks retrospective previews and does not open live findings. Partial windows and missing permission results are diagnostic rather than proof of absence.

## API

All workspace endpoints begin `/api/v1/workspaces/{workspaceId}`. Current session cookies authenticate. Mutations require the exact app origin and JSON. Run and export requests accept idempotency keys. Resource links and downloads are scoped at read time.

| Method | Suffix | Purpose |
| --- | --- | --- |
| GET | /overview | Overview, rules, activity, connectors |
| GET | /exceptions | Cursor-paginated findings, filterable by state, severity, owner, rule, and dates |
| GET or PATCH | /exceptions/{id} | Evidence and safe occurrence updates |
| POST | /connections | Add or replace connector credentials and scope settings |
| POST | /connections/{id}/test or /revoke | Queue a permission test or disconnect |
| POST | /rules | Create a validated draft |
| POST | /rules/{id}/draft, /preview, /evidence, /publish, or /pause | Manage configuration and evidence |
| POST | /runs | Queue a manual evaluation or baseline |
| GET | /runs/{id} or /runs/{id}/download | Read latest run state or download authorized output |
| POST | /exports | Queue a CSV export of exceptions |
| GET | /exports/{id} | Download valid export |
| GET | /reports | Audit events, exports and entitlement |
| POST | /settings | Edit workspace monitoring and alert preferences |
| GET or POST | /members | List scoped operators or create an invitation |

## Deployment scope and verification

The included release targets an initial deployment and design-partner verification. It implements the nine product workflows at the levels documented in Modules. Its server package uses a PostgreSQL lease queue, PostgreSQL-backed exports, SMTP, and AES-GCM with an operator-provided key. The PRD's alternative stack of managed AWS services, external billing, managed key rotation, and provider-specific live validation remain separate deployment work. The current code uses bounded reconciliation snapshots. Incremental time-window ingestion with automated backfill, shared workspaces across distinct organizations, automated PDF extraction, and enterprise SLO certification require additional implementation or qualification. The integration test exercises the real app, PostgreSQL, HTTP authorization, the worker, persisted ticket reconciliation, replay, audit, and exports using controlled evidence.

## Provider references

- [Next.js deployment documentation](https://nextjs.org/docs/app/guides/self-hosting)
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [ServiceNow Table API](https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html)
- [Jira Cloud enhanced issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Jira Cloud app authorization](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/)
- [WorkOS AuthKit documentation](https://workos.com/docs/authkit)

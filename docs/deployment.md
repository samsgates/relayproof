# Deployment and operations

## Runtime topology

Use Docker Compose on a dedicated Linux host for the supplied packaging. The web image contains the Next.js standalone server and static assets. A separate worker image runs jobs and migrations. The worker and web process share PostgreSQL but have independent pools. A one-shot migrator must succeed before either starts. For a managed database, run migrations with the separate migration URL and point web and worker at the non-owner runtime URL. Configure TLS and database certificates according to the hosting service.

For a public deployment, terminate TLS in a reverse proxy such as Caddy or an existing load balancer. A minimal host-based Caddy configuration is:

```caddy
relayproof.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Set `APP_URL` to the exact HTTPS origin. Keep `COOKIE_SECURE=true`. Public exposure should include reverse-proxy request limits and continuous patching. Configure a proxy request body limit above the app's 2 MB JSON ceiling for a normal evidence workflow. Avoid logging invitation query strings and authentication callbacks in proxy access logs. Protect the generated `.env`, use URL-safe Compose database passwords, and store the credential encryption key separately from the database backups. The app does not log provider response bodies or credentials.

## Identity and access

Provision local accounts with the script in the README. To provision an approved WorkOS identity, configure a WorkOS AuthKit app, register `<APP_URL>/api/auth/callback`, then pass a verified WorkOS user ID as the fourth CLI argument after the email and display name. WorkOS handles the upstream sign-in. RelayProof retains its own tenant and workspace membership checks. Keep uncontrolled sign-up disabled for a private server. A SaaS open-registration operating model needs a chosen email verification and abuse-prevention policy. Rotate or reset a local account using the administrator-managed identity process. Users receive private invite links through their administrators.

Jira OAuth uses an exact `<APP_URL>/api/v1/jira-callback` redirect and the Jira read and offline scopes. Set `JIRA_CLIENT_ID` and `JIRA_CLIENT_SECRET`; restart services after environment updates. When using an API token, grant the account only the intended project and issue visibility. Set `SERVICENOW_CUSTOM_HOSTS` only for vetted public HTTPS vanity domains. The connector restricts DNS resolution to public IPv4 destinations and does not follow redirects.

Configure `SMTP_URL` and `MAIL_FROM` to enable email alerts. Choose a TLS-capable authenticated SMTP service. Leave the workspace alert setting disabled until delivery has been tested. Source authorization is local to each workspace. Revoking a connection removes its local secret. Also revoke the credential at the source when the provider permits. For workspace membership, apply changes in Settings. Do not share service credentials through invitation links.

## Updates and backups

Before an upgrade, save the exact source release and a tested backup. Keep schema changes backward compatible during rollout. Build both application images from the same version, apply the one-shot migration, and confirm `/api/health` and worker logs before resuming normal traffic. Keep the previous image available. A rollback may require restoring a compatible database snapshot if a migration changed data semantics.

Back up the entire database and its role definitions using your standard PostgreSQL process. Managed environments can enable point-in-time recovery. Test restoration in a restricted environment, with provider access and outbound SMTP disabled until verified. Reapply customer deletions before connecting a restored environment to traffic. The archive does not set a contractual RPO or RTO. A single server has host-level failure exposure.

Avoid using `docker compose down -v` for a running customer environment. Inspect scheduled jobs, run history, worker logs and connector health for slow or failed processing. A degraded connector suppresses verified conclusions until coverage is established. A failed job preserves a sanitized failure code and can be retried via a new run after the cause has been corrected. Monitor queue age, PostgreSQL connection counts, persistent volume usage, and failed login volume with your infrastructure system.

## Configuration choices

On this blueprint, PostgreSQL stores bounded exports. Authorized users download through an API that checks their current role and expiry. Cloud object storage can replace this for high-volume installations. Credentials use AES-256-GCM with associated tenant and connection context. The same master key must be accessible to web and worker. A managed KMS and key-rotation procedure are deployment extensions for enterprise environments. PostgreSQL tables enforce tenant scope, and application queries enforce workspace scope and roles. Audit entries are append-only for the application role. Organize legal hold, archival, and operator access through your deployment policies.

The default plan allows one active workspace per tenant and 365 days of evaluation evidence. A database administrator can set entitled limits deliberately using the `relay.entitlements` table. Invoices are handled outside the app. Worker cleanup removes expired exports, inputs, observations, sessions and outdated runs. Audit lifecycle management, customer backup purge, and billing are operator-owned. Confirm retention, geography, and support responsibilities before receiving customer data.

An organization owner can request deletion from Settings. It pauses every workspace. A database administrator can review the pending request and, with approval, run `node --import tsx scripts/delete-tenant.ts --confirm <tenant-id>` with the migration database URL. This removes tenant data from the active database. Preserve a separate minimal deletion log for backup restoration and handle source credential revocation and backup expiry through the approved customer procedure.

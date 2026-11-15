# RelayProof

RelayProof is a multi-tenant B2B SaaS for verifying ServiceNow handoffs and related operational workflows. The primary workflow checks that ServiceNow ITSM incidents reach the right Jira Cloud project and that links and statuses remain consistent.

## Start here

- [Deployment and operations](docs/deployment.md)
- [Connector setup and module inputs](docs/modules.md)
- [Architecture, coverage, and API](docs/architecture.md)

### Deploy on a single server

1. Install Docker Engine and Docker Compose v2 on a Linux host. Configure DNS for RelayProof and prepare an HTTPS reverse proxy.
2. Generate secrets and deploy.

   ```sh
   ./scripts/setup-env.sh https://relayproof.example.com
   docker compose up -d --build
   docker compose ps
   ```

3. Provision the first account using a password from standard input. Use a unique password with at least 12 characters.

   ```sh
   read -rs RELAY_OWNER_PASSWORD
   printf '%s\n' "$RELAY_OWNER_PASSWORD" | docker compose run --rm -T worker \
     node --import tsx scripts/provision-user.ts admin@example.com 'RelayProof Administrator'
   unset RELAY_OWNER_PASSWORD
   ```

4. Sign in, create your organization, and follow the in-app Setup guide. Use your real integration accounts to finish provider verification.

Compose exposes the web service on server-local port 3000. It does not expose PostgreSQL to the public network. The service uses an unprivileged database role. Migrations use a separate role. Keep the PostgreSQL volume and encryption key in your backup plan.

## Local development

Use Node 24, npm, and PostgreSQL 17 or newer. Install with `npm ci`. Configure `DATABASE_ADMIN_URL`, `DATABASE_URL`, and `RELAY_ENCRYPTION_KEY`. For local HTTP use `APP_URL=http://localhost:3000` and `COOKIE_SECURE=false`. Run `npm run db:migrate`, provision an account or set `ALLOW_SIGNUP=true` in your isolated environment, then run `npm run dev` and `npm run worker` in separate shells. The migration creates the runtime role if necessary. Set the URL passwords with proper URI escaping.

Set `DEMO_MODE=true`, `DEMO_EMAIL`, and `DEMO_PASSWORD` and run `npm run db:demo` against a disposable database for a populated interface with synthetic observations. The demo providers contain no live credentials.

`npm test` runs evaluator and security boundary cases. `npm run typecheck` runs TypeScript checking. `npm run build` creates the Next.js standalone bundle. `npm run test:integration` tests the deployed HTTP API against real PostgreSQL and the worker. Run that suite only in a disposable environment with `ALLOW_SIGNUP=true` and `APP_URL` set.

## Release boundaries

The archive contains the Next.js application, workers, migrations, test suite, one-server deployment configuration, and operational documentation. It uses a PostgreSQL lease queue and SMTP. It includes application identity, optional WorkOS authentication, and optional Jira OAuth, with self-registration off by default. MSP reporting, vendor claims, upgrade readiness, and knowledge effectiveness take reviewed inputs. The related reports are generated in the platform and downloadable. Provision the providers and verify customer-specific permissions and mappings before enabling schedules. Review the documented constraints before making customer uptime, volume, or regulatory commitments.

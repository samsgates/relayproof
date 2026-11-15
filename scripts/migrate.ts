import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";

const url = process.env.DATABASE_ADMIN_URL;
const runtimeUrl = process.env.DATABASE_URL;
if (!url || !runtimeUrl) throw new Error("Set DATABASE_ADMIN_URL and DATABASE_URL");
const runtime = new URL(runtimeUrl);
const role = decodeURIComponent(runtime.username);
const password = decodeURIComponent(runtime.password);
if (!/^[a-z][a-z0-9_]{1,40}$/.test(role) || !password) throw new Error("Invalid runtime role configuration");
const sqlRole = '"' + role + '"';
const client = new Client({connectionString:url});
await client.connect();
try {
  const admin = await client.query("SELECT current_user");
  if (admin.rows[0].current_user === role) throw new Error("Runtime and database administrator roles must be different");
  await client.query("SELECT pg_advisory_lock(8994411)");
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[role]);
  if (!exists.rowCount) {
    const literal = (await client.query("SELECT quote_nullable($1::text) AS value",[password])).rows[0].value;
    await client.query(`CREATE ROLE ${sqlRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${literal}`);
  }
  const safeRole = await client.query(`SELECT NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS safe FROM pg_roles WHERE rolname=$1`,[role]);
  if (!safeRole.rows[0]?.safe) throw new Error("Database runtime role must be unprivileged");
  await client.query("CREATE SCHEMA IF NOT EXISTS relay");
  await client.query("CREATE TABLE IF NOT EXISTS relay.migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())");
  for (const name of (await readdir("db")).filter(file=>file.endsWith(".sql")).sort()) {
    const known = await client.query("SELECT 1 FROM relay.migrations WHERE name=$1",[name]);
    if (known.rowCount) continue;
    await client.query("BEGIN");
    try {
      await client.query(await readFile("db/"+name,"utf8"));
      await client.query("INSERT INTO relay.migrations(name) VALUES($1)",[name]);
      await client.query("COMMIT");
      console.log("Applied",name);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  await client.query(`GRANT USAGE ON SCHEMA relay TO ${sqlRole};
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA relay TO ${sqlRole};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA relay TO ${sqlRole};
    REVOKE ALL ON relay.migrations FROM ${sqlRole};
    REVOKE UPDATE,DELETE ON relay.audit_events, relay.rule_versions FROM ${sqlRole};`);
  console.log("Database ready");
} finally {
  await client.end();
}

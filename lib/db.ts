import { Pool, type PoolClient, type QueryResultRow } from "pg";

const singleton = globalThis as typeof globalThis & { relayPool?: Pool };
export function pool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return singleton.relayPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? "10"),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 15000,
    options: "-c search_path=relay,public -c statement_timeout=12000 -c idle_in_transaction_session_timeout=15000",
  });
}
export type Tx = PoolClient;
export async function transaction<T>(
  tenant: string | null,
  actor: string | null,
  use: (client: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('relay.tenant',$1,true),set_config('relay.actor',$2,true)", [tenant ?? "",actor ?? ""]);
    const data = await use(client);
    await client.query("COMMIT");
    return data;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
export async function one<T extends QueryResultRow>(client: Tx, sql: string, values: unknown[] = []) {
  return (await client.query<T>(sql,values)).rows[0];
}
export async function audit(client: Tx, tenant: string, workspace: string | null, actor: string | null,
                            event: string, target: string | null, detail: object = {}) {
  await client.query("INSERT INTO audit_events(tenant_id,workspace_id,actor_id,name,target,details) VALUES($1,$2,$3,$4,$5,$6)",
    [tenant,workspace,actor,event,target,detail]);
}

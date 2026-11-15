import { randomUUID } from "node:crypto";
import { one, pool, transaction, type Tx } from "./db";

export type JobKind="evaluate"|"baseline"|"connection"|"export"|"cleanup"|"notification";
export type Job={id:string;tenant_id:string;workspace_id:string;kind:JobKind;target_id:string|null;run_id:string|null;
  attempts:number;lease_token:string};
export async function enqueue(client:Tx, tenant:string,workspace:string, kind:JobKind, target:string|null, dedupe:string, run:string|null=null) {
  await client.query(`INSERT INTO jobs(tenant_id,workspace_id,kind,target_id,dedupe_key,run_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(dedupe_key) DO NOTHING`,[tenant,workspace,kind,target,dedupe,run]);
}
export async function createRun(client:Tx,tenant:string,workspace:string,kind:JobKind,target:string|null=null) {
  const run=randomUUID();
  await client.query("INSERT INTO runs(tenant_id,workspace_id,id,rule_id,kind) VALUES($1,$2,$3,$4,$5)",
    [tenant,workspace,run,kind==="evaluate"||kind==="baseline"?target:null,kind]);
  await enqueue(client,tenant,workspace,kind,target,run,run);
  return run;
}
export async function dispatch() {
  await transaction(null,null,async client=>{
    const candidates=(await client.query<{tenant_id:string;workspace_id:string;rule_id:string;interval_minutes:number}>(`
      SELECT tenant_id,workspace_id,rule_id,interval_minutes FROM schedule_routes WHERE next_at<=now()
      ORDER BY next_at LIMIT 20 FOR UPDATE SKIP LOCKED`)).rows;
    for(const item of candidates) {
      await client.query("SELECT set_config('relay.tenant',$1,true)",[item.tenant_id]);
      const enabled=await one(client,`SELECT r.id FROM rules r JOIN workspaces w ON w.tenant_id=r.tenant_id AND w.id=r.workspace_id
        JOIN entitlements e ON e.tenant_id=r.tenant_id JOIN organizations o ON o.id=r.tenant_id
        WHERE r.id=$1 AND r.enabled AND w.state='active' AND e.status='active' AND o.status='active'`,[item.rule_id]);
      await client.query("UPDATE schedule_routes SET next_at=now()+$2*interval '1 minute' WHERE tenant_id=$1 AND rule_id=$3",
        [item.tenant_id,item.interval_minutes,item.rule_id]);
      if(!enabled) continue;
      const running=await one(client,"SELECT 1 FROM jobs WHERE tenant_id=$1 AND target_id=$2 AND status IN ('queued','running') AND kind IN ('baseline','evaluate') LIMIT 1",[item.tenant_id,item.rule_id]);
      if(!running) await createRun(client,item.tenant_id,item.workspace_id,"evaluate",item.rule_id);
    }
  });
}
export async function lease() {
  return (await pool().query<Job>(`WITH next_job AS (
    SELECT id FROM jobs WHERE ((status='queued' AND available_at<=now()) OR (status='running' AND leased_until<now()))
    ORDER BY CASE WHEN kind IN ('evaluate','connection') THEN 0 WHEN kind='baseline' THEN 2 ELSE 1 END, available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
  ) UPDATE jobs j SET status='running',attempts=j.attempts+1,leased_until=now()+interval '90 seconds',lease_token=gen_random_uuid()
  FROM next_job WHERE j.id=next_job.id RETURNING j.*`)).rows[0];
}
export async function renew(job:Job) {
  return (await pool().query("UPDATE jobs SET leased_until=now()+interval '90 seconds' WHERE id=$1 AND lease_token=$2 AND status='running'",[job.id,job.lease_token])).rowCount===1;
}
export async function ownsLease(client:Tx,job:Job) {
  if(!await one(client,"SELECT 1 FROM jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND leased_until>now() FOR UPDATE",[job.id,job.lease_token]))
    throw new Error("job_lease_expired");
}
export async function finish(job:Job,error?:{code:string;retry:boolean;delay:number}) {
  await transaction(job.tenant_id,null,async client=>{
    const status=error?(error.retry&&job.attempts<6?"queued":"failed"):"succeeded";
    const updated=await client.query(`UPDATE jobs SET status=$3,available_at=now()+$4*interval '1 second',
      leased_until=NULL,lease_token=NULL,last_error=$5 WHERE id=$1 AND lease_token=$2`,
      [job.id,job.lease_token,status,error?.delay??0,error?.code??null]);
    if(!updated.rowCount||!error) return;
    if(job.run_id) await client.query("UPDATE runs SET status=$2,error=$3,finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END WHERE id=$1",
      [job.run_id,status,error.code]);
    if(job.kind==="export"&&status==="failed") await client.query("UPDATE exports SET status='failed',content=NULL WHERE id=$1",[job.target_id]);
    if(job.kind==="notification"&&status==="failed") await client.query("UPDATE inbox_outbox SET failed_at=now() WHERE id=$1",[job.target_id]);
  });
}

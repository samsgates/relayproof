import { Client } from "pg";
import { z } from "zod";

if(process.argv[2]!=="--confirm" || !process.env.DATABASE_ADMIN_URL)
  throw new Error("Requires database administrator credentials and --confirm <tenant-id>");
const tenant=z.uuid().parse(process.argv[3]);
const client=new Client({connectionString:process.env.DATABASE_ADMIN_URL});
await client.connect();
try{
  await client.query("BEGIN");
  await client.query("SELECT set_config('relay.tenant',$1,true)",[tenant]);
  const pending=await client.query("SELECT 1 FROM relay.deletion_requests WHERE tenant_id=$1 FOR UPDATE",[tenant]);
  if(!pending.rowCount) throw new Error("The organization must request deletion first.");
  const removed=await client.query("DELETE FROM relay.organizations WHERE id=$1 AND status='paused'",[tenant]);
  if(!removed.rowCount) throw new Error("No paused organization matched the approved request.");
  await client.query("COMMIT");
  console.log(JSON.stringify({event:"tenant.deleted",tenant,when:new Date().toISOString()}));
}catch(error){await client.query("ROLLBACK");throw error;}
finally{await client.end();}

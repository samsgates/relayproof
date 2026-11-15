import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pool } from "../../lib/db";
import { example } from "../../lib/examples";
import { modules } from "../../lib/catalog";

const base=process.env.APP_URL;
async function api(path:string, body?:unknown,cookie="",method=body===undefined?"GET":"POST",idempotency?:string){
  const response=await fetch(base+path,{method,headers:{origin:base??"",...(cookie?{cookie}:{}),
    ...(body===undefined?{}:{"Content-Type":"application/json"}),...(idempotency?{"Idempotency-Key":idempotency}:{})},
    body:body===undefined?undefined:JSON.stringify(body),redirect:"manual"});
  const type=response.headers.get("content-type")??"";
  return {status:response.status,res:response,data:type.includes("application/json")?await response.json():await response.text(),
    cookie:response.headers.get("set-cookie")?.split(";")[0]??""};
}
async function organization(suffix:string){
  const email=suffix+"-"+randomUUID().slice(0,8)+"@example.test";
  const reg=await api("/api/auth/register",{email,password:"integration-safe-2026",name:"Pilot Operator"});
  assert.equal(reg.status,200,JSON.stringify(reg.data));
  const org=await api("/api/v1/organizations",{name:"Pilot "+suffix,timezone:"UTC"},reg.cookie);
  assert.equal(org.status,201,JSON.stringify(org.data));
  return {cookie:reg.cookie,email,...org.data,root:"/api/v1/workspaces/"+org.data.workspace};
}
async function until<T>(get:()=>Promise<T>,match:(a:T)=>boolean){
  const begin=Date.now();
  let current=await get();
  while(!match(current)&&Date.now()-begin<18000){await delay(250);current=await get();}
  assert.ok(match(current),JSON.stringify(current));
  return current;
}
test("onboarding, permissions, persisted reconciliation, replay, audit, and export",async()=>{
  assert.ok(base,"APP_URL is required");
  const a=await organization("alpha"), b=await organization("beta");
  let req=await api(a.root+"/overview",undefined,b.cookie);
  assert.equal(req.status,404);
  req=await api(a.root+"/overview",undefined,a.cookie);
  assert.equal(req.status,200,JSON.stringify(req.data));
  const raw=(await pool().query("SELECT count(*)::int AS n FROM workspaces")).rows[0];
  assert.equal(raw.n,0,"runtime database role cannot bypass RLS");
  const rule=(await api(a.root+"/rules",{name:"Incident link verification",module:"tickets",config:{source:"evidence",graceMinutes:0}},a.cookie)).data;
  assert.ok(rule.id,JSON.stringify(rule));
  const saved=await api(a.root+"/rules/"+rule.id+"/publish",{},a.cookie);
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  const sample=example("tickets");
  for(let j=0;j<2;j++){
    const evidence=await api(a.root+"/rules/"+rule.id+"/evidence",{sample},a.cookie);
    assert.equal(evidence.status,200,JSON.stringify(evidence.data));
    const key=randomUUID();
    const run=await api(a.root+"/runs",{ruleId:rule.id,kind:"evaluate"},a.cookie,"POST",key);
    assert.equal(run.status,202,JSON.stringify(run.data));
    const repeated=await api(a.root+"/runs",{ruleId:rule.id,kind:"evaluate"},a.cookie,"POST",key);
    assert.equal(run.data.id,repeated.data.id);
    await until(()=>api(a.root+"/runs/"+run.data.id,undefined,a.cookie),r=>r.data.status==="succeeded");
  }
  let items=await api(a.root+"/exceptions",undefined,a.cookie);
  assert.equal(items.data.items.length,2,JSON.stringify(items.data));
  const id=items.data.items[0].id;
  let detail=await api(a.root+"/exceptions/"+id,undefined,a.cookie);
  assert.equal(detail.status,200);
  assert.ok(detail.data.evidence[0].evidence);
  req=await api(a.root+"/exceptions/"+id,{version:detail.data.item.version,action:"acknowledge"},a.cookie,"PATCH");
  assert.equal(req.status,200,JSON.stringify(req.data));
  detail=await api(a.root+"/exceptions/"+id,undefined,a.cookie);
  assert.equal(detail.data.item.state,"acknowledged");
  assert.equal(detail.data.history[0].name,"exception.acknowledge");
  const invite=await api(a.root+"/members",{email:b.email,role:"viewer"},a.cookie);
  const url=new URL(invite.data.link);
  const grant=await api("/api/v1/invite",Object.fromEntries(url.searchParams),b.cookie);
  assert.equal(grant.status,200,JSON.stringify(grant.data));
  assert.equal((await api(a.root+"/exceptions/"+id,undefined,b.cookie)).status,200);
  assert.equal((await api(a.root+"/exceptions/"+id,{version:detail.data.item.version,action:"dismiss",note:"Should be denied"},b.cookie,"PATCH")).status,403);
  const newExport=await api(a.root+"/exports",{},a.cookie);
  assert.equal(newExport.status,202,JSON.stringify(newExport.data));
  const csv=await until(()=>api(a.root+"/exports/"+newExport.data.id,undefined,a.cookie),r=>r.status===200);
  assert.match(csv.data,/Missing Jira handoff/);
  assert.equal((await api(a.root+"/exports/"+newExport.data.id,undefined,b.cookie)).status,403);
  items=await api(a.root+"/exceptions?state=acknowledged",undefined,a.cookie);
  assert.equal(items.data.items.length,1);
  const report=await api(a.root+"/reports",undefined,a.cookie);
  assert.ok(report.data.events.some((x:{name:string})=>x.name==="export.downloaded"));
  const revoked=await api(a.root+"/exports/"+newExport.data.id+"/revoke",{},a.cookie);
  assert.equal(revoked.status,202);
  assert.equal((await api(a.root+"/exports/"+newExport.data.id,undefined,a.cookie)).status,404);
});
test("the eight expansion workflows generate downloadable worker reports",async()=>{
  const team=await organization("portfolio");
  for(const module of modules.filter(m=>m.id!=="tickets")){
    const created=await api(team.root+"/rules",{name:module.name,module:module.id,config:{source:"evidence"}},team.cookie);
    assert.equal(created.status,200,JSON.stringify(created.data));
    const pre=team.root+"/rules/"+created.data.id;
    assert.equal((await api(pre+"/publish",{},team.cookie)).status,200);
    assert.equal((await api(pre+"/evidence",{sample:example(module.id)},team.cookie)).status,200);
    const run=await api(team.root+"/runs",{ruleId:created.data.id,kind:"evaluate"},team.cookie);
    assert.equal(run.status,202,JSON.stringify(run.data));
    const complete=await until(()=>api(team.root+"/runs/"+run.data.id,undefined,team.cookie),r=>r.data.status==="succeeded");
    assert.ok(Object.keys(complete.data.summary).length>1,module.id);
    const downloaded=await api(team.root+"/runs/"+run.data.id+"/download",undefined,team.cookie);
    assert.equal(downloaded.status,200);
    assert.match(downloaded.res.headers.get("Content-Disposition")??"",/attachment/);
  }
  const requested=await api(team.root+"/settings/delete",{organization:"Pilot portfolio"},team.cookie);
  assert.equal(requested.status,200,JSON.stringify(requested.data));
  const denied=await api(team.root+"/settings",{name:"Operations",timezone:"UTC",state:"active",alertEmails:false},team.cookie);
  assert.equal(denied.status,422,JSON.stringify(denied.data));
});
test.after(()=>pool().end());

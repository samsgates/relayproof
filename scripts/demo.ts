import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createOrganization, passwordHash, type User } from "../lib/auth";
import { pool, transaction } from "../lib/db";
import { example } from "../lib/examples";
import { modules, type ModuleId } from "../lib/catalog";

if(process.env.DEMO_MODE!=="true") throw new Error("Set DEMO_MODE=true only in an isolated demonstration environment");
const email=z.email().parse(process.env.DEMO_EMAIL).toLowerCase();
const password=z.string().min(12).max(200).parse(process.env.DEMO_PASSWORD);
const now=new Date();
const at=(minutes:number)=>new Date(now.getTime()-minutes*60_000);
try {
  const user=(await pool().query<User>("INSERT INTO users(email,name,password_hash) VALUES($1,'Avery Morgan',$2) RETURNING id,email,name",
    [email,await passwordHash(password)])).rows[0];
  const {tenant,workspace}=await createOrganization(user,"Northstar IT · Demo","UTC");
  await transaction(tenant,user.id,async client=>{
    await client.query("UPDATE workspaces SET name='Operations',state='active' WHERE id=$1",[workspace]);
    for(const [provider,label,host] of [["servicenow","ServiceNow","https://sample.service-now.com"],["jira","Jira Cloud","https://sample.atlassian.net"]]){
      await client.query(`INSERT INTO connections(tenant_id,workspace_id,provider,label,host,settings,health,last_success_at)
        VALUES($1,$2,$3,$4,$5,'{"synthetic":true}','healthy',$6)`,[tenant,workspace,provider,label,host,at(5)]);
    }
    const ids=new Map<ModuleId,string>();
    for(const m of modules){
      const rule=randomUUID(),config={source:"evidence",graceMinutes:15,intervalMinutes:5,severity:"high",settings:{}};
      ids.set(m.id,rule);
      await client.query("INSERT INTO rules(tenant_id,workspace_id,id,name,module,draft,version,enabled) VALUES($1,$2,$3,$4,$5,$6,1,true)",
        [tenant,workspace,rule,m.name,m.id,config]);
      await client.query("INSERT INTO rule_versions(tenant_id,rule_id,version,config,published_by) VALUES($1,$2,1,$3,$4)",[tenant,rule,config,user.id]);
      await client.query("INSERT INTO evidence_inputs(tenant_id,workspace_id,rule_id,source_kind,sample,created_by) VALUES($1,$2,$3,'synthetic',$4,$5)",
        [tenant,workspace,rule,example(m.id),user.id]);
    }
    const cases=[
      {module:"tickets",title:"Missing Jira handoff",subject:"INC001045",kind:"missing",severity:"critical",state:"open",age:29},
      {module:"tickets",title:"Duplicate Jira issues",subject:"INC001046",kind:"duplicate",severity:"high",state:"acknowledged",age:66},
      {module:"changes",title:"Deployment approval evidence",subject:"DEP-42",kind:"change",severity:"high",state:"open",age:145},
      {module:"offboarding",title:"Access remains after offboarding",subject:"TASK-114",kind:"access",severity:"medium",state:"open",age:1900},
      {module:"tickets",title:"Status mismatch",subject:"INC001019",kind:"status",severity:"medium",state:"resolved",age:2900},
      {module:"sla",title:"SLA deadline needs intervention",subject:"SLA-202",kind:"deadline",severity:"medium",state:"resolved",age:4300},
      {module:"cmdb",title:"Cloud inventory discrepancy",subject:"i-0972",kind:"inventory",severity:"low",state:"resolved",age:5950},
      {module:"upgrade",title:"Critical workflow needs sign-off",subject:"FLOW-11",kind:"readiness",severity:"low",state:"resolved",age:7140},
    ];
    for(const data of cases){
      const rule=ids.get(data.module as ModuleId),finding=randomUUID(),occ=randomUUID(),run=randomUUID();
      const closed=data.state==="resolved"?at(data.age-130):null;
      await client.query(`INSERT INTO findings(tenant_id,workspace_id,id,rule_id,subject,kind,title,severity,last_rule_version,last_outcome)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9)`,[tenant,workspace,finding,rule,data.subject,data.kind,data.title,data.severity,closed?"pass":"fail"]);
      await client.query(`INSERT INTO occurrences(tenant_id,workspace_id,finding_id,id,sequence,state,owner_id,opened_at,closed_at,closure_reason)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9)`,[tenant,workspace,finding,occ,data.state,data.kind==="missing"?null:user.id,at(data.age),closed,closed?"verified_fixed":null]);
      await client.query(`INSERT INTO runs(tenant_id,workspace_id,id,rule_id,kind,status,summary,created_at,finished_at)
        VALUES($1,$2,$3,$4,'evaluate','succeeded','{"synthetic":true}',$5,$5)`,[tenant,workspace,run,rule,at(data.age)]);
      await client.query(`INSERT INTO evaluations(tenant_id,workspace_id,rule_id,rule_version,run_id,finding_id,occurrence_id,outcome,evidence,observed_at)
        VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9)`,[tenant,workspace,rule,run,finding,occ,closed?"pass":"fail",
        {source:data.subject,expected:data.kind==="missing"?"One linked Jira issue":"Configured rule condition",observed:closed?"Verified fixed":"Discrepancy identified",synthetic:true},at(data.age)]);
    }
  });
  console.log("Demo workspace created for",email);
}finally{await pool().end();}

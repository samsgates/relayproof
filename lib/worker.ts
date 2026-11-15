import nodemailer from "nodemailer";
import { z } from "zod";
import { audit, one, pool, transaction, type Tx } from "./db";
import { createRun, enqueue, ownsLease, type Job } from "./jobs";
import { collectLive, connectionTest, moduleProviders, ProviderError, type Connection } from "./providers";
import { baseConfig, evaluate, schemas, validateRule, type Analysis, type Config, type Result } from "./rules";
import type { ModuleId } from "./catalog";

type RuleRecord={id:string;name:string;module:ModuleId;version:number;config:Config;enabled:boolean;state:string;entitled:boolean};
type Logical={id:string;streak:number;last_outcome:string;last_rule_version:number;streak_at:Date|null;divergent_since:Date|null};
const isObject=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
export function csvCell(value:unknown) {
  let str=value===null||value===undefined?"":typeof value==="object"?JSON.stringify(value):String(value);
  if(/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(str)) str="'"+str;
  return '"'+str.replaceAll('"','""')+'"';
}
async function runStatus(client:Tx,job:Job,status:string,summary:object) {
  if(job.run_id) await client.query("UPDATE runs SET status=$2,summary=$3,error=NULL,finished_at=CASE WHEN $2='running' THEN NULL ELSE now() END WHERE id=$1",[job.run_id,status,summary]);
}
async function notification(client:Tx,job:Job,occurrence:string,kind:string,title:string) {
  const settings=await one<{alert_emails:boolean}>(client,"SELECT alert_emails FROM workspaces WHERE id=$1",[job.workspace_id]);
  if(!settings?.alert_emails) return;
  const slot=Math.floor(Date.now()/600000)*600000;
  const out=await one<{id:string}>(client,`INSERT INTO inbox_outbox(tenant_id,workspace_id,dedupe_key,summary)
    VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,dedupe_key) DO UPDATE SET summary=jsonb_build_object(
      'count',(inbox_outbox.summary->>'count')::int+1,
      'entries',CASE WHEN jsonb_array_length(inbox_outbox.summary->'entries')<15 THEN
        (inbox_outbox.summary->'entries')||(excluded.summary->'entries') ELSE inbox_outbox.summary->'entries' END)
    RETURNING id`,[job.tenant_id,job.workspace_id,"digest:"+job.workspace_id+":"+slot,{count:1,entries:[{occurrence,kind,title}]}]);
  if(out){
    await enqueue(client,job.tenant_id,job.workspace_id,"notification",out.id,"email:"+out.id);
    await client.query("UPDATE jobs SET available_at=$2 WHERE dedupe_key=$1 AND status='queued'",
      ["email:"+out.id,new Date(slot+630000)]);
  }
}
async function applyResult(client:Tx,job:Job,rule:RuleRecord,config:Config,input:Result,observed:Date,existing?:Logical) {
  if(!existing&&input.outcome!=="fail") return;
  const finding=existing??await one<Logical>(client,`INSERT INTO findings(tenant_id,workspace_id,rule_id,subject,kind,title,severity,first_due_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,streak,last_outcome,last_rule_version,streak_at,divergent_since`,
    [job.tenant_id,job.workspace_id,rule.id,input.subject,input.kind,input.title,config.severity,input.dueAt??null]);
  if(!finding) return;
  let outcome=input.outcome;
  const consistentVersion=finding.last_rule_version===rule.version;
  let divergentSince=consistentVersion?finding.divergent_since:null;
  if(input.kind==="status"&&outcome==="fail") {
    divergentSince??=observed;
    if(observed.getTime()-divergentSince.getTime()<config.graceMinutes*60000) outcome="unknown";
  } else if(outcome==="pass") divergentSince=null;
  const minimumInterval=config.source==="live"?Math.min(config.intervalMinutes,5)*60000:0;
  const repeated=consistentVersion&&finding.last_outcome===outcome;
  const advances=!repeated||!finding.streak_at||observed.getTime()-finding.streak_at.getTime()>=minimumInterval;
  const streak=repeated?finding.streak+(advances?1:0):1;
  const streakAt=advances?observed:finding.streak_at;
  let current=await one<{id:string;state:string}>(client,"SELECT id,state FROM occurrences WHERE finding_id=$1 AND closed_at IS NULL FOR UPDATE",[finding.id]);
  const last=current?undefined:await one<{state:string}>(client,"SELECT state FROM occurrences WHERE finding_id=$1 ORDER BY sequence DESC LIMIT 1",[finding.id]);
  const rejected=last?.state==="dismissed"&&consistentVersion&&finding.last_outcome!=="pass";
  if(outcome==="fail"&&streak>=(input.confirmations??1)&&!current&&!rejected){
    current=await one(client,`INSERT INTO occurrences(tenant_id,workspace_id,finding_id,sequence,state,owner_id,opened_at)
      SELECT $1,$2,$3,COALESCE(MAX(sequence),0)+1,'open',
       (SELECT m.user_id FROM memberships m WHERE m.user_id=$4 AND (m.role='owner' OR EXISTS(
         SELECT 1 FROM workspace_memberships wm WHERE wm.user_id=m.user_id AND wm.workspace_id=$2))),$5
      FROM occurrences WHERE finding_id=$3 RETURNING id,state`,[job.tenant_id,job.workspace_id,finding.id,config.ownerId??null,observed]);
    if(current){
      await audit(client,job.tenant_id,job.workspace_id,null,"exception.opened",current.id,{ruleVersion:rule.version});
      await notification(client,job,current.id,"opened",input.title);
    }
  }
  if(outcome==="pass"&&streak>=(input.recovery??1)&&current){
    await client.query("UPDATE occurrences SET state='resolved',closed_at=now(),closure_reason='verified_fixed',version=version+1 WHERE id=$1",[current.id]);
    await audit(client,job.tenant_id,job.workspace_id,null,"exception.verified_fixed",current.id,{ruleVersion:rule.version});
  }
  await client.query(`UPDATE findings SET severity=$2,title=$3,streak=$4,last_outcome=$5,streak_at=$6,last_seen_at=$7,
    last_observation=$8,last_rule_version=$9,divergent_since=$10 WHERE id=$1`,
    [finding.id,config.severity,input.title,streak,outcome,streakAt,observed,job.run_id,rule.version,divergentSince]);
  await client.query(`INSERT INTO evaluations(tenant_id,workspace_id,rule_id,rule_version,run_id,finding_id,occurrence_id,outcome,evidence,observed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,run_id,finding_id) DO NOTHING`,
    [job.tenant_id,job.workspace_id,rule.id,rule.version,job.run_id,finding.id,current?.id??null,outcome,
      {...input.evidence,outcome,confirmationCount:streak,divergentSince:divergentSince?.toISOString()},observed]);
}
async function evaluateJob(job:Job) {
  if(!job.run_id||!job.target_id) throw new Error("job_target_required");
  const state=await transaction(job.tenant_id,null,async client=>{
    const rule=await one<RuleRecord>(client,`SELECT r.id,r.name,r.module,r.version,r.enabled,v.config,w.state,(e.status='active' AND o.status='active') entitled
      FROM rules r JOIN rule_versions v ON v.tenant_id=r.tenant_id AND v.rule_id=r.id AND v.version=r.version
      JOIN workspaces w ON w.tenant_id=r.tenant_id AND w.id=r.workspace_id JOIN entitlements e ON e.tenant_id=r.tenant_id
      JOIN organizations o ON o.id=r.tenant_id WHERE r.id=$1 AND r.workspace_id=$2`,[job.target_id,job.workspace_id]);
    const already=await one<{status:string}>(client,"SELECT status FROM runs WHERE id=$1",[job.run_id]);
    if(already?.status==="succeeded"||already?.status==="partial") return;
    if(!rule||!rule.enabled||!rule.entitled||(job.kind==="evaluate"&&rule.state==="paused")){
      await runStatus(client,job,"canceled",{reason:"rule_or_workspace_inactive"});
      return;
    }
    const config=validateRule(rule.module,baseConfig.parse(rule.config));
    const sample=config.source==="evidence"?await one<{id:string;sample:unknown}>(client,"SELECT id,sample FROM evidence_inputs WHERE rule_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",[rule.id]):undefined;
    const cons=(await client.query<Connection>("SELECT * FROM connections WHERE workspace_id=$1",[job.workspace_id])).rows;
    await runStatus(client,job,"running",{});
    return {rule,config,sample,cons};
  });
  if(!state) return;
  const started=new Date();
  const {rule,config,cons}=state;
  let sample:unknown;
  try {
    if(config.source==="live") sample=await collectLive(rule.module,config,cons,started,job.kind==="baseline");
    else if(state.sample) sample=state.sample.sample;
    else throw new ProviderError("evidence_required");
  } catch(error) {
    if(config.source==="live") await transaction(job.tenant_id,null,async client=>{
      await ownsLease(client,job);
      const code=error instanceof ProviderError?error.code:"provider_or_mapping_error";
      await client.query("UPDATE connections SET health='degraded',last_error=$3 WHERE workspace_id=$1 AND provider=ANY($2::text[]) AND health NOT IN ('revoked','untested')",
        [job.workspace_id,moduleProviders[rule.module]??[],code]);
      await client.query(`INSERT INTO checkpoints(tenant_id,workspace_id,rule_id,source,state) VALUES($1,$2,$3,'comparison','degraded')
        ON CONFLICT(tenant_id,rule_id,source) DO UPDATE SET state='degraded'`,[job.tenant_id,job.workspace_id,rule.id]);
    });
    throw error;
  }
  const observed=new Date();
  await transaction(job.tenant_id,null,async client=>{
    await ownsLease(client,job);
    const published=await one<{version:number;enabled:boolean;state:string;allowed:boolean}>(client,
      `SELECT r.version,r.enabled,w.state,(o.status='active' AND e.status='active') AS allowed FROM rules r
        JOIN workspaces w ON w.tenant_id=r.tenant_id AND w.id=r.workspace_id JOIN organizations o ON o.id=r.tenant_id
        JOIN entitlements e ON e.tenant_id=r.tenant_id WHERE r.id=$1 FOR UPDATE OF r,w`,[rule.id]);
    if(published?.version!==rule.version||!published.enabled||!published.allowed||(job.kind==="evaluate"&&published.state==="paused")){
      await runStatus(client,job,"canceled",{reason:"rule_changed_during_run"});
      return;
    }
    let result:Analysis;
    if(rule.module==="tickets"){
      const data=schemas.tickets.parse(sample);
      const subjects=data.incidents.map(row=>row.id);
      const firstSeen=new Map<string,Date>();
      if(job.kind!=="baseline"&&data.coverage&&subjects.length){
        const unique=[...new Set(subjects)];
        const first=(await client.query<{subject:string;first_seen:Date}>(`INSERT INTO subject_observations(tenant_id,workspace_id,rule_id,subject,first_seen,last_seen)
          SELECT $1,$2,$3,item,$5,$5 FROM unnest($4::text[]) item ON CONFLICT(tenant_id,rule_id,subject) DO UPDATE
          SET first_seen=CASE WHEN $5-subject_observations.last_seen>interval '24 hours' THEN $5 ELSE subject_observations.first_seen END,
          last_seen=$5 RETURNING subject,first_seen`,[job.tenant_id,job.workspace_id,rule.id,unique,observed])).rows;
        for(const item of first) firstSeen.set(item.subject,item.first_seen);
      }
      result=evaluate(rule.module,sample,config,observed,firstSeen);
    } else result=evaluate(rule.module,sample,config,observed);
    const complete=result.report.coverage!==false&&result.report.complete!==false;
    const preview=result.findings.filter(x=>x.outcome==="fail").slice(0,30).map(x=>({title:x.title,subject:x.subject,evidence:x.evidence}));
    if(job.kind==="baseline"){
      await runStatus(client,job,complete?"succeeded":"partial",{...result.report,baseline:true,
        retrospective:true,preview,unknown:result.findings.filter(x=>x.outcome==="unknown").length});
      return;
    }
    if(state.sample){
      const duplicate=await one(client,"SELECT 1 FROM runs WHERE rule_id=$1 AND evidence_input_id=$2 AND status IN ('succeeded','partial') AND kind='evaluate' AND id<>$3",
        [rule.id,state.sample.id,job.run_id]);
      if(duplicate){
        await runStatus(client,job,"succeeded",{...result.report,replayedEvidence:true,preview});
        return;
      }
      await client.query("UPDATE runs SET evidence_input_id=$2 WHERE id=$1",[job.run_id,state.sample.id]);
    }
    const known=(await client.query<Logical&{subject:string;kind:string}>(`SELECT id,subject,kind,streak,last_outcome,last_rule_version,streak_at,divergent_since
      FROM findings WHERE rule_id=$1 FOR UPDATE`,[rule.id])).rows;
    const map=new Map(known.map(x=>[x.subject+"\0"+x.kind,x]));
    for(const input of result.findings) await applyResult(client,job,rule,config,input,observed,map.get(input.subject+"\0"+input.kind));
    if(config.source==="live"){
      const state=complete?"healthy":"degraded";
      await client.query(`INSERT INTO checkpoints(tenant_id,workspace_id,rule_id,source,cursor,completed_at,state)
        VALUES($1,$2,$3,'comparison',$4,CASE WHEN $5='healthy' THEN $6 ELSE NULL END,$5)
        ON CONFLICT(tenant_id,rule_id,source) DO UPDATE SET state=excluded.state,cursor=excluded.cursor,
        completed_at=COALESCE(excluded.completed_at,checkpoints.completed_at)`,[job.tenant_id,job.workspace_id,rule.id,
        {windowCompletedAt:observed.toISOString()},state,observed]);
      await client.query(`UPDATE connections SET health=$3,last_error=CASE WHEN $3='healthy' THEN NULL ELSE 'coverage_unverified' END,
        last_success_at=CASE WHEN $3='healthy' THEN $4 ELSE last_success_at END WHERE workspace_id=$1 AND provider=ANY($2::text[])
        AND health<>'revoked'`,[job.workspace_id,moduleProviders[rule.module]??[],state,observed]);
    }
    await runStatus(client,job,complete?"succeeded":"partial",{...result.report,preview,
      checked:result.findings.length,failed:result.findings.filter(x=>x.outcome==="fail").length,
      unknown:result.findings.filter(x=>x.outcome==="unknown").length});
  });
}
async function testConnection(job:Job){
  const con=await transaction(job.tenant_id,null,client=>one<Connection>(client,"SELECT * FROM connections WHERE id=$1 AND workspace_id=$2 AND health<>'revoked'",[job.target_id,job.workspace_id]));
  if(!con) throw new ProviderError("connection_not_found");
  try {
    const result=await connectionTest(con);
    await transaction(job.tenant_id,null,async client=>{
      await ownsLease(client,job);
      await client.query("UPDATE connections SET health='healthy',last_success_at=now(),last_error=NULL WHERE id=$1 AND health<>'revoked'",[con.id]);
      await runStatus(client,job,"succeeded",result);
    });
  } catch(error) {
    await transaction(job.tenant_id,null,async client=>{
      await ownsLease(client,job);
      await client.query("UPDATE connections SET health='degraded',last_error=$2 WHERE id=$1 AND health<>'revoked'",
        [con.id,error instanceof ProviderError?error.code:"provider_configuration_error"]);
    });
    throw error;
  }
}
async function exportJob(job:Job){
  await transaction(job.tenant_id,null,async client=>{
    await ownsLease(client,job);
    const exp=await one<{filters:Record<string,string>;status:string;actor_id:string}>(client,"SELECT filters,status,actor_id FROM exports WHERE id=$1 AND workspace_id=$2 AND expires_at>now() FOR UPDATE",[job.target_id,job.workspace_id]);
    if(!exp||exp.status==="succeeded") return;
    const active=await one(client,`SELECT 1 FROM memberships m WHERE m.user_id=$1 AND (m.role='owner' OR EXISTS (
      SELECT 1 FROM workspace_memberships wm WHERE wm.user_id=m.user_id AND wm.workspace_id=$2 AND wm.role IN ('admin','auditor')))`,[exp.actor_id,job.workspace_id]);
    if(!active){await client.query("UPDATE exports SET status='failed' WHERE id=$1",[job.target_id]);return;}
    const rows=(await client.query(`SELECT o.id,f.title,f.subject,f.kind,f.severity,o.state,o.opened_at,o.closed_at,
      r.name AS rule,e.rule_version,e.observed_at,e.outcome,e.evidence
      FROM occurrences o JOIN findings f ON f.tenant_id=o.tenant_id AND f.id=o.finding_id
      JOIN rules r ON r.tenant_id=f.tenant_id AND r.id=f.rule_id
      LEFT JOIN LATERAL (SELECT rule_version,observed_at,outcome,evidence FROM evaluations v WHERE v.occurrence_id=o.id
        ORDER BY observed_at DESC LIMIT 1) e ON true
      WHERE o.workspace_id=$1 AND ($2::text IS NULL OR o.state=$2) AND ($3::text IS NULL OR f.severity=$3)
      ORDER BY o.opened_at DESC,o.id DESC LIMIT 5001`,[job.workspace_id,exp.filters.state??null,exp.filters.severity??null])).rows;
    if(rows.length>5000) throw new ProviderError("export_row_limit");
    const columns=["id","title","subject","kind","severity","state","opened_at","closed_at","rule","rule_version","observed_at","outcome","evidence"];
    const csv=[columns.join(","),...rows.map(item=>columns.map(key=>csvCell(item[key])).join(","))].join("\r\n");
    if(Buffer.byteLength(csv)>10_000_000) throw new ProviderError("export_size_limit");
    await client.query("UPDATE exports SET status='succeeded',content=$2,row_count=$3 WHERE id=$1",[job.target_id,csv,rows.length]);
    await audit(client,job.tenant_id,job.workspace_id,exp.actor_id,"export.generated",job.target_id,{filters:exp.filters,rowCount:rows.length});
  });
}
async function sendNotification(job:Job){
  if(!process.env.SMTP_URL||!process.env.MAIL_FROM) throw new ProviderError("email_not_configured");
  const pending=await transaction(job.tenant_id,null,async client=>{
    const out=await one<{summary:{count:number;entries:{title:string;occurrence:string}[]};delivered_at:Date|null}>(client,"SELECT summary,delivered_at FROM inbox_outbox WHERE id=$1",[job.target_id]);
    const workspace=await one<{name:string;alert_emails:boolean}>(client,"SELECT name,alert_emails FROM workspaces WHERE id=$1",[job.workspace_id]);
    const addresses=(await client.query<{email:string}>(`SELECT DISTINCT u.email FROM users u JOIN memberships m ON m.user_id=u.id
      LEFT JOIN workspace_memberships wm ON wm.tenant_id=m.tenant_id AND wm.user_id=u.id AND wm.workspace_id=$1
      WHERE m.role='owner' OR wm.role IN ('admin','operator') ORDER BY u.email LIMIT 100`,[job.workspace_id])).rows.map(x=>x.email);
    return {out,workspace,addresses};
  });
  if(!pending.out||pending.out.delivered_at) return;
  if(pending.workspace?.alert_emails&&pending.addresses.length){
    const smtp=new URL(process.env.SMTP_URL);
    if (!["smtp:","smtps:"].includes(smtp.protocol)) throw new ProviderError("email_configuration_invalid");
    const secure=smtp.protocol==="smtps:";
    const mail=nodemailer.createTransport({host:smtp.hostname,port:Number(smtp.port|| (secure?465:587)),secure,requireTLS:!secure,
      auth:smtp.username?{user:decodeURIComponent(smtp.username),pass:decodeURIComponent(smtp.password)}:undefined,
      connectionTimeout:12000,greetingTimeout:12000,socketTimeout:20000,disableFileAccess:true,disableUrlAccess:true});
    const url=new URL("/w/"+job.workspace_id+"/exceptions",process.env.APP_URL??"http://localhost:3000");
    const count=pending.out.summary.count;
    const lines=pending.out.summary.entries.map(entry=>"- "+entry.title+" "+url.toString()+"/"+entry.occurrence);
    try {
      await mail.sendMail({from:process.env.MAIL_FROM,bcc:pending.addresses,subject:"RelayProof · "+count+" new exceptions in "+pending.workspace.name,
        messageId:"<"+job.target_id+"@"+url.hostname+">",text:lines.join("\n")+"\n\nOpen the inbox: "+url.toString()});
    } catch {throw new ProviderError("email_delivery_failed",true);}
    finally {mail.close();}
  }
  await transaction(job.tenant_id,null,async client=>{
    await ownsLease(client,job);
    await client.query("UPDATE inbox_outbox SET delivered_at=now() WHERE id=$1",[job.target_id]);
  });
}
export async function cleanTenants(){
  await pool().query("DELETE FROM sessions WHERE expires_at<now()");
  await pool().query("DELETE FROM rate_limits WHERE expires_at<now()");
  const routes=(await pool().query<{tenant_id:string}>("SELECT tenant_id FROM tenant_routes ORDER BY tenant_id")).rows;
  for(const route of routes) await transaction(route.tenant_id,null,async client=>{
    const days=(await one<{evidence_days:number}>(client,"SELECT evidence_days FROM entitlements"))?.evidence_days??365;
    await client.query("DELETE FROM exports WHERE expires_at<now()");
    await client.query("DELETE FROM idempotency WHERE created_at<now()-interval '24 hours'");
    await client.query("DELETE FROM evidence_inputs WHERE created_at<now()-interval '90 days'");
    await client.query("DELETE FROM subject_observations WHERE last_seen<now()-interval '90 days'");
    await client.query("DELETE FROM source_records WHERE observed_at<now()-interval '90 days'");
    await client.query("DELETE FROM evaluations WHERE observed_at<now()-$1*interval '1 day'",[days]);
    await client.query(`DELETE FROM runs WHERE created_at<now()-interval '30 days' AND NOT EXISTS(
      SELECT 1 FROM evaluations e WHERE e.run_id=runs.id)`);
    await client.query("DELETE FROM jobs WHERE tenant_id=$1 AND status IN ('succeeded','failed') AND created_at<now()-interval '30 days'",[route.tenant_id]);
    await client.query(`UPDATE occurrences SET state='open',suppressed_until=NULL,version=version+1
      WHERE state='suppressed' AND suppressed_until<=now()`);
  });
}
export async function processJob(job:Job){
  if(job.kind==="evaluate"||job.kind==="baseline"){
    const lock=await pool().connect();
    try {
      const held=await one<{locked:boolean}>(lock,"SELECT pg_try_advisory_lock(hashtextextended($1,22)) AS locked",[job.target_id]);
      if(!held?.locked) throw new ProviderError("rule_busy",true,30);
      await evaluateJob(job);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,22))",[job.target_id]).catch(()=>undefined);
      lock.release();
    }
    return;
  }
  switch(job.kind){
    case "connection":return testConnection(job);
    case "export":return exportJob(job);
    case "notification":return sendNotification(job);
    case "cleanup":return cleanTenants();
  }
}
export function sanitizeWorkerError(error:unknown,attempts:number) {
  if(error instanceof ProviderError) return {code:error.code,retry:error.retryable,delay:Math.min(3600,Math.max(error.retryAfter,2**attempts*10+Math.floor(Math.random()*10)))};
  if(error instanceof z.ZodError) return {code:"validation_or_source_format",retry:false,delay:0};
  if(isObject(error)&&typeof error.code==="string"&&(error.code.startsWith("08")||["40001","40P01","57014"].includes(error.code)))
    return {code:"database_transient",retry:true,delay:30};
  return {code:"internal_worker_error",retry:true,delay:60};
}

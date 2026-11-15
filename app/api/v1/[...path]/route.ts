import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import { checkOrigin, createOrganization, currentUser, getScope, hash, HttpError, inScope, origin,
  requireRole, securityCookie, throttle, token, uuidPattern, type Scope } from "@/lib/auth";
import { audit, one, transaction, type Tx } from "@/lib/db";
import { fail, input, missing, reply } from "@/lib/http";
import { providers, type ModuleId } from "@/lib/catalog";
import { seal, unseal } from "@/lib/crypto";
import { createRun, enqueue } from "@/lib/jobs";
import { approvedHost, credentialContext, fixedHost, jiraCredentials, jiraLoginToken, moduleProviders, providerRequest, validateCredentials } from "@/lib/providers";
import { baseConfig, evaluate, ruleInput, schemas, validateRule } from "@/lib/rules";
import { dashboard, exceptionDetail, getFilterParams, listExceptions, reports, validFilters, workspacePeople } from "@/lib/read-model";

type Params={params:Promise<{path:string[]}>};
type Rule={id:string;module:ModuleId;draft:unknown;version:number;enabled:boolean};
const admin=["owner","admin"] as const;
const operator=["owner","admin","operator"] as const;
const auditors=["owner","admin","auditor"] as const;
const roles=z.enum(["admin","operator","viewer","auditor"]);
const label=z.string().trim().min(2).max(100);
const timezone=z.string().max(80).refine(v=>{try{new Intl.DateTimeFormat("en",{timeZone:v});return true;}catch{return false;}},"Enter an IANA time zone");
const parseId=(value?:string)=>value&&uuidPattern.test(value)?value:missing();
function guard(scope:Scope, list:readonly Scope["role"][]){requireRole(scope,[...list]);}
async function idem<T>(request:Request,scope:Scope,client:Tx,body:unknown,run:()=>Promise<T>){
  const key=request.headers.get("idempotency-key")??"";
  if(!key)return run();
  if(!/^[\w.:/-]{8,128}$/.test(key)) throw new HttpError(422,"invalid_key","Use a valid idempotency key.");
  const fingerprint=hash(request.method+" "+new URL(request.url).pathname+" "+JSON.stringify(body));
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,56))",[scope.tenant+":"+scope.user.id+":"+key]);
  const saved=await one<{fingerprint:string;response:T}>(client,"SELECT fingerprint,response FROM idempotency WHERE actor_id=$1 AND key=$2",[scope.user.id,key]);
  if(saved){
    if(saved.fingerprint!==fingerprint) throw new HttpError(409,"idempotency_conflict","This key belongs to an earlier request.");
    return saved.response;
  }
  const response=await run();
  await client.query("INSERT INTO idempotency(tenant_id,actor_id,key,fingerprint,response) VALUES($1,$2,$3,$4,$5)",[scope.tenant,scope.user.id,key,fingerprint,JSON.stringify(response)]);
  return response;
}
async function pickRule(client:Tx,scope:Scope,id:string,lock=false){
  return await one<Rule>(client,"SELECT id,module,draft,version,enabled FROM rules WHERE workspace_id=$1 AND id=$2"+(lock?" FOR UPDATE":""),[scope.workspace,id])??missing();
}
async function assertOwner(client:Tx,scope:Scope,id?:string|null){
  if(!id) return;
  if(!await one(client,`SELECT m.user_id FROM memberships m LEFT JOIN workspace_memberships wm ON wm.tenant_id=m.tenant_id AND wm.user_id=m.user_id
    AND wm.workspace_id=$2 WHERE m.user_id=$1 AND (m.role='owner' OR wm.role IN ('admin','operator'))`,[id,scope.workspace]))
    throw new HttpError(422,"invalid_owner","Choose an operator or administrator in this workspace.");
}
async function saveConnection(client:Tx,scope:Scope,body:unknown){
  const p=z.object({provider:z.enum(providers),label,host:z.string().optional(),settings:z.record(z.string(),z.unknown()).default({}),credentials:z.unknown()}).parse(body);
  const host=approvedHost(p.provider,p.host??(p.provider in fixedHost?fixedHost[p.provider as keyof typeof fixedHost]:""));
  const parsed=validateCredentials(p.provider,p.credentials);
  if(p.provider==="jira" && (parsed as {mode?:string}).mode!=="token") throw new HttpError(422,"oauth_required","Use the authorized Jira connection flow.");
  const key=({servicenow:"sampleIncident",jira:"sampleIssue",github:"repository",entra:"sampleUser",aws:"region"})[p.provider];
  const field=z.string().max(150).parse(p.settings[key]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,40))",[scope.workspace+":"+p.provider]);
  const existing=await one<{id:string}>(client,"SELECT id FROM connections WHERE workspace_id=$1 AND provider=$2 FOR UPDATE",[scope.workspace,p.provider]);
  const id=existing?.id??randomUUID();
  await client.query(`INSERT INTO connections(tenant_id,workspace_id,id,provider,label,host,settings,credentials)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,workspace_id,provider) DO UPDATE SET
    label=excluded.label,host=excluded.host,settings=excluded.settings,credentials=excluded.credentials,health='untested',
    last_success_at=NULL,last_error=NULL,updated_at=now()`,[scope.tenant,scope.workspace,id,p.provider,p.label,host,{[key]:field},seal(parsed,credentialContext(scope.tenant,id))]);
  await audit(client,scope.tenant,scope.workspace,scope.user.id,"connection.saved",id,{provider:p.provider});
  return {id};
}
async function jiraOAuth(scope:Scope,request:Request,step:string){
  guard(scope,admin);
  const clientId=process.env.JIRA_CLIENT_ID,secret=process.env.JIRA_CLIENT_SECRET;
  if(!clientId||!secret) throw new HttpError(422,"oauth_disabled","Jira OAuth is unavailable on this server.");
  const jar=await cookies(), url=new URL(request.url);
  const base=origin()+"/api/v1/jira-callback";
  const portCookie="relay_jira_oauth";
  if(step==="start"){
    const host=approvedHost("jira",url.searchParams.get("host")??"");
    const issue=z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/).parse(url.searchParams.get("sampleIssue"));
    const state=token();
    jar.set(portCookie,seal({state:hash(state),user:scope.user.id,workspace:scope.workspace,host,issue},"jira-oauth"),{...securityCookie,maxAge:600});
    const auth=new URL("https://auth.atlassian.com/authorize");
    auth.search=new URLSearchParams({audience:"api.atlassian.com",client_id:clientId,scope:"read:jira-work offline_access",redirect_uri:base,state,response_type:"code",prompt:"consent"}).toString();
    return Response.redirect(auth);
  }
  return missing();
}
async function completeJiraOAuth(request:Request,user:Scope["user"]){
  const jar=await cookies(), encoded=jar.get("relay_jira_oauth")?.value;
  jar.set("relay_jira_oauth","",{...securityCookie,maxAge:0});
  const url=new URL(request.url), state=url.searchParams.get("state"), code=url.searchParams.get("code");
  if(!encoded||!state||!code) throw new HttpError(400,"oauth_state","Start the Jira authorization again.");
  let grant:{state:string;user:string;workspace:string;host:string;issue:string};
  try { grant=unseal(encoded,"jira-oauth"); } catch { throw new HttpError(400,"oauth_state","Start the Jira authorization again."); }
  if(grant.state!==hash(state)||grant.user!==user.id) throw new HttpError(400,"oauth_state","Start the Jira authorization again.");
  const scope=await getScope(user,grant.workspace);
  if(!scope)return missing();
  guard(scope,admin);
  const auth=await jiraLoginToken({grant_type:"authorization_code",client_id:process.env.JIRA_CLIENT_ID,
    client_secret:process.env.JIRA_CLIENT_SECRET,code,redirect_uri:origin()+"/api/v1/jira-callback"});
  const accessToken=z.string().min(1).parse(auth.access_token);
  const resources=await providerRequest<{id:string;url:string}[]>(new URL("https://api.atlassian.com/oauth/token/accessible-resources"),
    {headers:{Authorization:"Bearer "+accessToken}});
  const chosen=resources.data.find(resource=>resource.url===grant.host);
  if(!chosen)throw new HttpError(422,"jira_scope","The authorized account cannot access that Jira site.");
  const creds=jiraCredentials.options[1].parse({mode:"oauth",accessToken,refreshToken:auth.refresh_token,
    expiresAt:Date.now()+Number(auth.expires_in??3600)*1000,cloudId:chosen.id});
  await inScope(scope,async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,40))",[scope.workspace+":jira"]);
    const old=await one<{id:string}>(client,"SELECT id FROM connections WHERE workspace_id=$1 AND provider='jira' FOR UPDATE",[scope.workspace]);
    const id=old?.id??randomUUID();
    await client.query(`INSERT INTO connections(tenant_id,workspace_id,id,provider,label,host,settings,credentials)
      VALUES($1,$2,$3,'jira','Jira Cloud',$4,$5,$6) ON CONFLICT(tenant_id,workspace_id,provider)
      DO UPDATE SET host=excluded.host,settings=excluded.settings,credentials=excluded.credentials,
      health='untested',last_success_at=NULL,last_error=NULL,updated_at=now()`,
      [scope.tenant,scope.workspace,id,grant.host,{sampleIssue:grant.issue},seal(creds,credentialContext(scope.tenant,id))]);
    await audit(client,scope.tenant,scope.workspace,user.id,"connection.authorized",id,{provider:"jira"});
  });
  return Response.redirect(origin()+"/w/"+scope.workspace+"/connections");
}
async function mutate(request:Request,scope:Scope,section:string,rest:string[]){
  const [raw,action]=rest;
  const body=await input(request);
  if(section==="settings"){
    guard(scope,admin);
    if(raw==="delete"){
      guard(scope,["owner"]);
      const p=z.object({organization:label}).parse(body);
      if(p.organization!==scope.organization) throw new HttpError(422,"confirmation","Enter the organization name exactly as shown.");
      return inScope(scope,async client=>{
        const record=await client.query("INSERT INTO deletion_requests(tenant_id,requested_by) VALUES($1,$2) ON CONFLICT DO NOTHING",[scope.tenant,scope.user.id]);
        if(record.rowCount){
          await client.query("UPDATE organizations SET status='paused' WHERE id=$1",[scope.tenant]);
          await client.query("UPDATE workspaces SET state='paused' WHERE tenant_id=$1",[scope.tenant]);
          await audit(client,scope.tenant,scope.workspace,scope.user.id,"organization.deletion_requested",scope.tenant);
        }
        return {ok:true};
      });
    }
    const p=z.object({name:label,timezone,state:z.enum(["setup","active","paused"]),alertEmails:z.boolean()}).parse(body);
    if(p.alertEmails&&!(process.env.SMTP_URL&&process.env.MAIL_FROM)) throw new HttpError(422,"email_disabled","Configure SMTP and the sender before enabling workspace email.");
    return inScope(scope,async client=>{
      if(p.state==="active"){
        const organization=await one<{status:string}>(client,"SELECT status FROM organizations WHERE id=$1",[scope.tenant]);
        if(organization?.status!=="active") throw new HttpError(422,"organization_paused","This organization is paused.");
        const plan=await one<{active_scope_limit:number;status:string}>(client,"SELECT active_scope_limit,status FROM entitlements FOR UPDATE");
        const count=await one<{number:number}>(client,"SELECT count(*)::int AS number FROM workspaces WHERE id<>$1 AND state='active'",[scope.workspace]);
        if(!plan||plan.status!=="active"||(count?.number??0)>=plan.active_scope_limit)
          throw new HttpError(422,"plan_limit","Your plan does not allow another active workspace.");
      }
      await client.query("UPDATE workspaces SET name=$2,timezone=$3,state=$4,alert_emails=$5,updated_at=now() WHERE id=$1",
        [scope.workspace,p.name,p.timezone,p.state,p.alertEmails]);
      await audit(client,scope.tenant,scope.workspace,scope.user.id,"workspace.settings",scope.workspace,{state:p.state,email:p.alertEmails});
      return {ok:true};
    });
  }
  if(section==="workspaces"){
    guard(scope,["owner"]);
    const p=z.object({name:label,timezone}).parse(body);
    return inScope(scope,async client=>{
      const id=randomUUID();
      await client.query("INSERT INTO workspaces(tenant_id,id,name,timezone) VALUES($1,$2,$3,$4)",[scope.tenant,id,p.name,p.timezone]);
      await audit(client,scope.tenant,id,scope.user.id,"workspace.created",id);
      return {id};
    });
  }
  if(section==="members"){
    guard(scope,admin);
    if(!raw){
      const p=z.object({email:z.email().transform(x=>x.toLowerCase()),role:roles}).parse(body);
      return inScope(scope,async client=>{
        const key=token();
        await client.query(`INSERT INTO invites(tenant_id,workspace_id,email,role,digest,expires_at)
          VALUES($1,$2,$3,$4,$5,now()+interval '7 days')`,[scope.tenant,scope.workspace,p.email,p.role,hash(key)]);
        await audit(client,scope.tenant,scope.workspace,scope.user.id,"member.invited",null,{role:p.role});
        const link=new URL("/invite",origin());
        link.search=new URLSearchParams({tenant:scope.tenant,workspace:scope.workspace,token:key}).toString();
        return {link:link.toString()};
      });
    }
    guard(scope,["owner"]);
    const user=parseId(raw);
    const p=z.object({role:roles.nullable()}).parse(body);
    return inScope(scope,async client=>{
      if(p.role) await client.query("UPDATE workspace_memberships SET role=$3 WHERE user_id=$1 AND workspace_id=$2",[user,scope.workspace,p.role]);
      else await client.query("DELETE FROM workspace_memberships WHERE user_id=$1 AND workspace_id=$2",[user,scope.workspace]);
      await audit(client,scope.tenant,scope.workspace,scope.user.id,p.role?"member.role_changed":"member.revoked",user,{role:p.role});
      return {ok:true};
    });
  }
  if(section==="connections"){
    guard(scope,admin);
    if(!raw)return inScope(scope,client=>saveConnection(client,scope,body));
    const id=parseId(raw);
    return inScope(scope,async client=>{
      if(!await one(client,"SELECT id FROM connections WHERE workspace_id=$1 AND id=$2",[scope.workspace,id]))return missing();
      if(action==="test") return idem(request,scope,client,body,async()=>({id:await createRun(client,scope.tenant,scope.workspace,"connection",id)}));
      if(action==="revoke"){
        await client.query("UPDATE connections SET credentials=NULL,health='revoked',updated_at=now() WHERE id=$1",[id]);
        await audit(client,scope.tenant,scope.workspace,scope.user.id,"connection.revoked",id);
        return {ok:true};
      }
      return missing();
    });
  }
  if(section==="rules"){
    guard(scope,admin);
    if(!raw){
      const p=ruleInput.parse(body), config=parseConfig(p.module,p.config);
      return inScope(scope,async client=>{
        await assertOwner(client,scope,config.ownerId);
        const id=randomUUID();
        await client.query("INSERT INTO rules(tenant_id,workspace_id,id,name,module,draft) VALUES($1,$2,$3,$4,$5,$6)",[scope.tenant,scope.workspace,id,p.name,p.module,config]);
        await audit(client,scope.tenant,scope.workspace,scope.user.id,"rule.created",id,{module:p.module});
        return {id};
      });
    }
    const id=parseId(raw);
    return inScope(scope,async client=>{
      const rule=await pickRule(client,scope,id,true);
      if(action==="draft"){
        const p=z.object({name:label,config:baseConfig}).parse(body), config=parseConfig(rule.module,p.config);
        await assertOwner(client,scope,config.ownerId);
        await client.query("UPDATE rules SET draft=$2,name=$3,updated_at=now() WHERE id=$1",[id,config,p.name]);
        await audit(client,scope.tenant,scope.workspace,scope.user.id,"rule.draft_saved",id);
        return {ok:true};
      }
      const config=parseConfig(rule.module,baseConfig.parse(rule.draft));
      if(action==="preview"||action==="evidence"){
        const p=z.object({sample:z.unknown()}).parse(body);
        const sample=schemas[rule.module].parse(p.sample);
        const result=evaluate(rule.module,sample,config);
        if(action==="preview") return {report:result.report,findings:result.findings.slice(0,25),total:result.findings.length};
        const sampleId=randomUUID();
        await client.query(`INSERT INTO evidence_inputs(tenant_id,workspace_id,rule_id,id,source_kind,sample,created_by)
          VALUES($1,$2,$3,$4,'reviewed_json',$5,$6)`,[scope.tenant,scope.workspace,id,sampleId,sample,scope.user.id]);
        await audit(client,scope.tenant,scope.workspace,scope.user.id,"evidence.uploaded",id,{sampleId});
        return {id:sampleId};
      }
      if(action==="pause"){
        await client.query("UPDATE rules SET enabled=false,updated_at=now() WHERE id=$1",[id]);
        await client.query("DELETE FROM schedule_routes WHERE rule_id=$1",[id]);
        await audit(client,scope.tenant,scope.workspace,scope.user.id,"rule.paused",id);
        return {ok:true};
      }
      if(action==="publish"){
        await assertOwner(client,scope,config.ownerId);
        if(config.source==="live"){
          const needed=moduleProviders[rule.module]??[];
          const count=await one<{n:number}>(client,"SELECT COUNT(*)::int n FROM connections WHERE workspace_id=$1 AND provider=ANY($2::text[]) AND health='healthy'",[scope.workspace,needed]);
          if(count?.n!==needed.length) throw new HttpError(422,"connection_health","Test and verify all required connections before publishing.");
        }
        const version=rule.version+1;
        await client.query("INSERT INTO rule_versions(tenant_id,rule_id,version,config,published_by) VALUES($1,$2,$3,$4,$5)",[scope.tenant,id,version,config,scope.user.id]);
        await client.query("UPDATE rules SET version=$2,enabled=true,updated_at=now() WHERE id=$1",[id,version]);
        if(rule.version){
          await client.query(`UPDATE occurrences o SET state='dismissed',closed_at=now(),closure_reason='rule_superseded',version=o.version+1
            FROM findings f WHERE o.tenant_id=f.tenant_id AND o.finding_id=f.id AND f.rule_id=$1 AND o.closed_at IS NULL`,[id]);
        }
        if(config.source==="live"){
          await client.query(`INSERT INTO schedule_routes(tenant_id,workspace_id,rule_id,interval_minutes) VALUES($1,$2,$3,$4)
            ON CONFLICT(tenant_id,rule_id) DO UPDATE SET interval_minutes=excluded.interval_minutes,next_at=now()`,[scope.tenant,scope.workspace,id,config.intervalMinutes]);
        }else await client.query("DELETE FROM schedule_routes WHERE rule_id=$1",[id]);
        await audit(client,scope.tenant,scope.workspace,scope.user.id,"rule.published",id,{version});
        return {version};
      }
      return missing();
    });
  }
  if(section==="runs"){
    guard(scope,admin);
    const p=z.object({ruleId:z.uuid(),kind:z.enum(["evaluate","baseline"])}).parse(body);
    await throttle("run:"+scope.workspace+":"+scope.user.id,12,60);
    return inScope(scope,client=>idem(request,scope,client,body,async()=>{
      const rule=await pickRule(client,scope,p.ruleId);
      if(!rule.enabled) throw new HttpError(422,"rule_unpublished","Publish the rule before running it.");
      return {id:await createRun(client,scope.tenant,scope.workspace,p.kind,p.ruleId)};
    }));
  }
  if(section==="exceptions"){
    guard(scope,operator);
    const id=parseId(raw);
    const p=z.object({version:z.number().int().positive(),action:z.enum(["assign","acknowledge","suppress","dismiss","comment"]),
      ownerId:z.uuid().nullable().optional(),until:z.iso.datetime({offset:true}).optional(),note:z.string().trim().min(2).max(500).optional()}).parse(body);
    return inScope(scope,async client=>{
      const item=await one<{id:string;state:string;version:number;closed_at:Date|null}>(client,"SELECT id,state,version,closed_at FROM occurrences WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[scope.workspace,id]);
      if(!item)return missing();
      if(item.version!==p.version) throw new HttpError(409,"exception_changed","Refresh the exception before making another change.");
      if(item.closed_at&&p.action!=="comment") throw new HttpError(422,"exception_closed","This occurrence has closed.");
      if(p.action==="assign"){
        await assertOwner(client,scope,p.ownerId);
        await client.query("UPDATE occurrences SET owner_id=$2,version=version+1 WHERE id=$1",[id,p.ownerId??null]);
      }else if(p.action==="acknowledge"){
        await client.query("UPDATE occurrences SET state='acknowledged',suppressed_until=NULL,version=version+1 WHERE id=$1",[id]);
      }else if(p.action==="suppress"){
        if(!p.note||!p.until||Date.parse(p.until)<=Date.now()||Date.parse(p.until)>Date.now()+90*86400000)
          throw new HttpError(422,"suppression", "Enter a reason and suppression expiry within 90 days.");
        await client.query("UPDATE occurrences SET state='suppressed',suppressed_until=$2,version=version+1 WHERE id=$1",[id,p.until]);
      }else if(p.action==="dismiss"){
        if(!p.note) throw new HttpError(422,"reason_required","Enter a disposition reason.");
        await client.query("UPDATE occurrences SET state='dismissed',closed_at=now(),closure_reason=$2,suppressed_until=NULL,version=version+1 WHERE id=$1",[id,p.note]);
      }else{
        if(!p.note) throw new HttpError(422,"note_required","Enter a note.");
        await client.query("UPDATE occurrences SET version=version+1 WHERE id=$1",[id]);
      }
      await audit(client,scope.tenant,scope.workspace,scope.user.id,"exception."+p.action,id,
        {owner:p.ownerId,note:p.note,until:p.until});
      return {ok:true};
    });
  }
  if(section==="exports"){
    guard(scope,auditors);
    if(raw&&action==="revoke"){
      const id=parseId(raw);
      return inScope(scope,async client=>{
        const updated=await client.query("UPDATE exports SET content=NULL,status='revoked',expires_at=now() WHERE id=$1 AND workspace_id=$2",[id,scope.workspace]);
        if(!updated.rowCount) return missing();
        await audit(client,scope.tenant,scope.workspace,scope.user.id,"export.revoked",id);
        return {ok:true};
      });
    }
    const p=validFilters.pick({state:true,severity:true}).parse(body);
    await throttle("exports:"+scope.workspace+":"+scope.user.id,6,60);
    return inScope(scope,client=>idem(request,scope,client,body,async()=>{
      const id=randomUUID();
      await client.query("INSERT INTO exports(tenant_id,workspace_id,id,actor_id,filters) VALUES($1,$2,$3,$4,$5)",[scope.tenant,scope.workspace,id,scope.user.id,p]);
      await enqueue(client,scope.tenant,scope.workspace,"export",id,"export:"+id);
      await audit(client,scope.tenant,scope.workspace,scope.user.id,"export.requested",id,{filters:p});
      return {id};
    }));
  }
  return missing();
}
function parseConfig(module:ModuleId,config:z.infer<typeof baseConfig>){
  if(config.source==="live"&&!moduleProviders[module]) throw new HttpError(422,"evidence_required","Choose reviewed evidence for this module.");
  return validateRule(module,config);
}
async function route(request:Request,{params}:Params){
  try {
    const path=(await params).path, write=request.method!=="GET";
    if(write)checkOrigin(request);
    const user=await currentUser();
    if(!user) throw new HttpError(401,"login_required","Sign in to continue.");
    if(path[0]==="jira-callback"&&!write)return completeJiraOAuth(request,user);
    if(path[0]==="organizations"&&write){
      const payload=z.object({name:label,timezone}).parse(await input(request));
      await throttle("organization:"+user.id,6,3600);
      return reply(await createOrganization(user,payload.name,payload.timezone),201);
    }
    if(path[0]==="invite"&&write){
      const p=z.object({tenant:z.uuid(),workspace:z.uuid(),token:z.string().length(43)}).parse(await input(request));
      await throttle("invite:"+user.id,12,900);
      const accepted=await transaction(p.tenant,user.id,async client=>{
        const grant=await one<{id:string;role:string}>(client,`SELECT id,role FROM invites WHERE workspace_id=$1 AND email=$2
          AND digest=$3 AND expires_at>now() AND consumed_at IS NULL FOR UPDATE`,[p.workspace,user.email,hash(p.token)]);
        if(!grant)return missing();
        await client.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[p.tenant,user.id,grant.role]);
        await client.query(`INSERT INTO workspace_memberships(tenant_id,workspace_id,user_id,role) VALUES($1,$2,$3,$4)
          ON CONFLICT(tenant_id,workspace_id,user_id) DO UPDATE SET role=excluded.role`,[p.tenant,p.workspace,user.id,grant.role]);
        await client.query("UPDATE invites SET consumed_at=now() WHERE id=$1",[grant.id]);
        await audit(client,p.tenant,p.workspace,user.id,"member.joined",user.id,{role:grant.role});
        return {workspace:p.workspace};
      });
      return reply(accepted);
    }
    if(path[0]!=="workspaces")return missing();
    const workspace=parseId(path[1]),scope=await getScope(user,workspace);
    if(!scope)return missing();
    const section=path[2]??"overview",rest=path.slice(3);
    if(write)return reply(await mutate(request,scope,section,rest),["runs","exports"].includes(section)?202:200);
    if(section==="jira-oauth")return jiraOAuth(scope,request,rest[0]);
    if(section==="overview")return reply(await dashboard(scope));
    if(section==="exceptions")return reply(rest[0]?await exceptionDetail(scope,parseId(rest[0])):await listExceptions(scope,getFilterParams(new URL(request.url).searchParams),new URL(request.url).searchParams.get("cursor")));
    if(section==="members"){guard(scope,operator);return reply(await workspacePeople(scope));}
    if(section==="reports"){guard(scope,auditors);return reply(await reports(scope));}
    if(section==="exports"&&rest[0]){
      guard(scope,auditors);
      const id=parseId(rest[0]);
      const item=await inScope(scope,async client=>{
        const exp=await one<{content:string}>(client,"SELECT content FROM exports WHERE id=$1 AND workspace_id=$2 AND status='succeeded' AND expires_at>now()",[id,scope.workspace]);
        if(!exp?.content)return missing();
        await audit(client,scope.tenant,scope.workspace,user.id,"export.downloaded",id);
        return exp;
      });
      return new Response(item.content,{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="relayproof-'+id+'.csv"',"Cache-Control":"private, no-store"}});
    }
    if(section==="runs"&&rest[0]){
      const id=parseId(rest[0]);
      const run=await inScope(scope,async client=>await one(client,"SELECT * FROM runs WHERE workspace_id=$1 AND id=$2",[scope.workspace,id])??missing());
      if(rest[1]==="download"){
        guard(scope,auditors);
        await inScope(scope,client=>audit(client,scope.tenant,scope.workspace,user.id,"report.downloaded",id));
        return new Response(JSON.stringify(run,null,2),{headers:{"Content-Type":"application/json","Content-Disposition":'attachment; filename="relayproof-run-'+id+'.json"',"Cache-Control":"private, no-store"}});
      }
      return reply(run);
    }
    return missing();
  }catch(error){return fail(error);}
}
export const GET=route;
export const POST=route;
export const PATCH=route;

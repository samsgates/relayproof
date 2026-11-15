import { lookup } from "node:dns/promises";
import { request } from "node:https";
import ipaddr from "ipaddr.js";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import { liveSchema, type Config } from "./rules";
import type { ModuleId, Provider } from "./catalog";
import { seal, unseal } from "./crypto";
import { one, transaction } from "./db";

type Json=Record<string,unknown>;
type Reply<T>={data:T; headers:Record<string,string|string[]|undefined>};
export class ProviderError extends Error {
  constructor(public code:string,public retryable=false,public retryAfter=0){super(code);}
}
export function approvedHost(provider:Provider, raw:string) {
  let url:URL;
  try {url=new URL(raw);} catch {throw new ProviderError("invalid_host");}
  const {hostname}=url;
  const serviceNow = /^[a-z0-9][a-z0-9-]*\.service-now\.com$/.test(hostname) ||
    (process.env.SERVICENOW_CUSTOM_HOSTS??"").split(",").map(x=>x.trim().toLowerCase()).includes(hostname);
  const valid=provider==="servicenow"?serviceNow:provider==="jira"?/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(hostname):
    hostname===({github:"api.github.com",entra:"graph.microsoft.com",aws:"aws.amazon.com"} as Record<string,string>)[provider];
  if(!valid || url.protocol!=="https:" || url.username || url.password || url.port || url.pathname!=="/" || url.search || url.hash)
    throw new ProviderError("host_not_allowed");
  return url.origin;
}
export const fixedHost={github:"https://api.github.com",entra:"https://graph.microsoft.com",aws:"https://aws.amazon.com"} as const;

async function publicAddress(host:string) {
  const addresses=await lookup(host,{all:true,family:4,verbatim:true});
  if (!addresses.length || addresses.some(result=>ipaddr.parse(result.address).range()!=="unicast"))
    throw new ProviderError("provider_dns_blocked");
  return addresses[0].address;
}
export async function providerRequest<T>(url:URL, options:{method?:string; headers?:Record<string,string>; body?:string}={}):Promise<Reply<T>> {
  if(url.protocol!=="https:"||url.port||url.username||url.password) throw new ProviderError("host_not_allowed");
  let address:string;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    address=await Promise.race([publicAddress(url.hostname),new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new ProviderError("provider_dns_timeout",true)),5000);
    })]);
  } catch(error) {
    if(error instanceof ProviderError) throw error;
    throw new ProviderError("provider_dns_error",true);
  } finally { if(timer) clearTimeout(timer); }
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:options.method??"GET",headers:{Accept:"application/json",...options.headers},
      signal:AbortSignal.timeout(18000),family:4, lookup:(_hostname,_options,done)=>done(null,address,4)},res=>{
      const status=res.statusCode??0;
      if(status<200||status>=300) {
        res.resume();
        const limit=Number(res.headers["retry-after"]??0);
        const retry=Number.isFinite(limit)?limit:0;
        if(status===429 || (status===403&&res.headers["x-ratelimit-remaining"]==="0")) reject(new ProviderError("provider_rate_limit",true,retry));
        else if(status===401||status===403) reject(new ProviderError("provider_permission"));
        else if(status===404) reject(new ProviderError("provider_not_found"));
        else if(status>=500) reject(new ProviderError("provider_unavailable",true));
        else reject(new ProviderError("provider_rejected_"+status));
        return;
      }
      const chunks:Buffer[]=[];
      let bytes=0;
      res.on("data",(chunk:Buffer)=>{
        bytes+=chunk.length;
        if(bytes>8_000_000) res.destroy(new ProviderError("provider_payload_limit"));
        else chunks.push(chunk);
      });
      res.on("error",error=>reject(error instanceof ProviderError?error:new ProviderError("provider_network",true)));
      res.on("end",()=>{
        try {resolve({data:JSON.parse(Buffer.concat(chunks).toString("utf8")) as T,headers:res.headers});}
        catch {reject(new ProviderError("provider_response_invalid"));}
      });
    });
    req.on("error",()=>reject(new ProviderError("provider_network",true)));
    req.end(options.body);
  });
}

export type Connection={tenant_id:string;workspace_id:string;id:string;provider:Provider;host:string;credentials:string|null;settings:Json;health:string};
export const serviceCredentials=z.object({clientId:z.string().min(1).max(200),clientSecret:z.string().min(1).max(1000)});
export const jiraCredentials=z.union([
  z.object({mode:z.literal("token"),email:z.email(),token:z.string().min(1).max(2000)}),
  z.object({mode:z.literal("oauth"),accessToken:z.string(),refreshToken:z.string(),expiresAt:z.number(),cloudId:z.uuid()}),
]);
const githubCredentials=z.object({token:z.string().min(1).max(2000)});
const entraCredentials=z.object({directoryId:z.uuid(),clientId:z.uuid(),clientSecret:z.string().min(1).max(2000)});
const awsCredentials=z.object({accessKeyId:z.string().min(1).max(200),secretAccessKey:z.string().min(1).max(500),sessionToken:z.string().max(5000).optional()});
const credentialSchemas={servicenow:serviceCredentials,jira:jiraCredentials,github:githubCredentials,entra:entraCredentials,aws:awsCredentials};
export function validateCredentials(provider:Provider,value:unknown) {return credentialSchemas[provider].parse(value);}
export const credentialContext=(tenant:string,id:string)=>tenant+":"+id;
const text=(value:unknown)=>typeof value==="string"&&value.length?value:undefined;
const stable=(value:unknown)=>typeof value==="number"?String(value):text(value);
const obj=(value:unknown):Json=>value && typeof value==="object" && !Array.isArray(value) ? value as Json : {};
function array(value:unknown):Json[] {
  if(!Array.isArray(value)) throw new ProviderError("provider_response_invalid");
  return value.map(obj);
}
function time(value:unknown) {
  const input=text(value);
  if(!input) return undefined;
  const n=Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(input)?input.replace(" ","T")+"Z":input);
  return Number.isFinite(n)?new Date(n).toISOString():undefined;
}
const utc=(date:Date)=>date.toISOString().slice(0,19).replace("T"," ");
const validDate=(x:unknown)=>time(x)??new Date(0).toISOString();
const bool=(x:unknown)=>x===true||x==="true";
const ref=(x:unknown)=>text(x)??text(obj(x).value);
function normalize(value:unknown) {
  const raw=text(value)?.trim();
  if(!raw||raw.length>150) return null;
  return /^[a-f0-9]{32}$/i.test(raw)?raw.toLowerCase():/^inc\d+$/i.test(raw)?raw.toUpperCase():raw;
}
const bearer=(token:string)=>({Authorization:"Bearer "+token});
const deadline=(days:number)=>new Date(Date.now()-days*86400000);
const link=(host:string,table:string,id:string)=>host+"/"+table+".do?sys_id="+encodeURIComponent(id);

export async function formToken(endpoint:string, form:Record<string,string>) {
  const {data}=await providerRequest<Json>(new URL(endpoint),{method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(form).toString()});
  const value=text(data.access_token);
  if(!value) throw new ProviderError("provider_authorization_invalid");
  return value;
}

export async function jiraLoginToken(body:Json) {
  return (await providerRequest<Json>(new URL("https://auth.atlassian.com/oauth/token"),{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
  })).data;
}
export async function jiraAuth(con:Connection) {
  const context=credentialContext(con.tenant_id,con.id);
  if(!con.credentials) throw new ProviderError("credentials_required");
  const initial=jiraCredentials.parse(unseal(con.credentials,context));
  if(initial.mode==="token"){
    return {base:con.host,headers:{Authorization:"Basic "+Buffer.from(initial.email+":"+initial.token).toString("base64")}};
  }
  const creds=initial.expiresAt>Date.now()+120000 ? initial : await transaction(con.tenant_id,null,async client=>{
    const locked=await one<{credentials:string|null}>(client,"SELECT credentials FROM connections WHERE id=$1 FOR UPDATE",[con.id]);
    if(!locked?.credentials) throw new ProviderError("credentials_required");
    const current=jiraCredentials.parse(unseal(locked.credentials,context));
    if(current.mode!=="oauth") throw new ProviderError("credentials_changed");
    if(current.expiresAt>Date.now()+120000) return current;
    if(!process.env.JIRA_CLIENT_ID||!process.env.JIRA_CLIENT_SECRET) throw new ProviderError("oauth_not_configured");
    // Token rotation must be serialized. The bounded request occurs only in this credential transaction.
    await client.query("SET LOCAL idle_in_transaction_session_timeout='30s'");
    const result=await jiraLoginToken({grant_type:"refresh_token",client_id:process.env.JIRA_CLIENT_ID,
      client_secret:process.env.JIRA_CLIENT_SECRET,refresh_token:current.refreshToken});
    const renewed=jiraCredentials.options[1].parse({...current,accessToken:result.access_token,
      refreshToken:result.refresh_token??current.refreshToken,expiresAt:Date.now()+Number(result.expires_in??3600)*1000});
    await client.query("UPDATE connections SET credentials=$2 WHERE id=$1",[con.id,seal(renewed,context)]);
    return renewed;
  });
  return {base:"https://api.atlassian.com/ex/jira/"+creds.cloudId,headers:bearer(creds.accessToken)};
}
export async function serviceAuth(con:Connection) {
  const creds=serviceCredentials.parse(secrets(con));
  return bearer(await formToken(con.host+"/oauth_token.do",{grant_type:"client_credentials",client_id:creds.clientId,client_secret:creds.clientSecret}));
}
function secrets(con:Connection) {
  if(!con.credentials) throw new ProviderError("credentials_required");
  return unseal(con.credentials,credentialContext(con.tenant_id,con.id));
}
async function serviceTable(con:Connection, auth:Record<string,string>, table:string, query:string, fields:string[], limit:number) {
  const pageSize=Math.min(200,limit);
  const found:Json[]=[];
  const seen=new Set<string>();
  for(let offset=0;offset<=limit+pageSize;offset+=pageSize) {
    const url=new URL("/api/now/table/"+table,con.host);
    url.search=new URLSearchParams({sysparm_query:query+"^ORDERBYsys_id",sysparm_fields:[...new Set(["sys_id",...fields])].join(","),
      sysparm_limit:String(pageSize),sysparm_offset:String(offset),sysparm_display_value:"false",sysparm_exclude_reference_link:"true"}).toString();
    const response=await providerRequest<{result:unknown}>(url,{headers:auth});
    const page=array(response.data.result);
    for(const r of page) {
      const key=text(r.sys_id);
      if(!key || seen.has(key)) throw new ProviderError("provider_pagination_inconsistent",true);
      seen.add(key);
      found.push(r);
    }
    if(found.length>limit) throw new ProviderError("scope_record_limit");
    const pagination=String(response.headers.link??"");
    if(!pagination.includes('rel="next"')&&page.length<pageSize) return found;
  }
  throw new ProviderError("provider_pagination_incomplete");
}
async function serviceGet(con:Connection, auth:Record<string,string>, table:string,id:string,fields:string[]) {
  const url=new URL("/api/now/table/"+table+"/"+encodeURIComponent(id),con.host);
  url.search=new URLSearchParams({sysparm_fields:fields.join(","),sysparm_exclude_reference_link:"true",sysparm_display_value:"false"}).toString();
  return (await providerRequest<{result:Json}>(url,{headers:auth})).data.result;
}
async function jiraSearch(con:Connection,settings:z.output<typeof liveSchema.tickets>) {
  const {base,headers}=await jiraAuth(con);
  const project=(await providerRequest<Json>(new URL(base+"/rest/api/3/project/"+settings.projectId),{headers})).data;
  if(stable(project.id)!==settings.projectId||project.key!==settings.projectKey) throw new ProviderError("jira_scope_changed");
  const jql='project = '+settings.projectId+' ORDER BY key ASC';
  const seen=new Set<string>();
  const tokens=new Set<string>();
  const issues:Json[]=[];
  let nextPageToken:string|undefined;
  do {
    const result=(await providerRequest<Json>(new URL(base+"/rest/api/3/search/jql"),{
      method:"POST",headers:{...headers,"Content-Type":"application/json"},
      body:JSON.stringify({jql,maxResults:100,fields:["status","updated",settings.jiraField],nextPageToken,failFast:true}),
    })).data;
    for(const issue of array(result.issues)) {
      const id=stable(issue.id);
      if(!id||seen.has(id)) throw new ProviderError("provider_pagination_inconsistent",true);
      seen.add(id);
      issues.push(issue);
    }
    if(issues.length>settings.maxRecords) throw new ProviderError("scope_record_limit");
    nextPageToken=text(result.nextPageToken);
    if(nextPageToken&&tokens.has(nextPageToken)) throw new ProviderError("provider_pagination_inconsistent",true);
    if(nextPageToken) tokens.add(nextPageToken);
    if(result.isLast===false&&!nextPageToken) throw new ProviderError("provider_pagination_incomplete",true);
  } while(nextPageToken);
  return issues;
}
function need(connections:Connection[],provider:Provider) {
  const item=connections.find(x=>x.provider===provider&&x.health!=="revoked");
  if(!item) throw new ProviderError(provider+"_connection_missing");
  approvedHost(provider,item.host);
  return item;
}
export const moduleProviders:Partial<Record<ModuleId,Provider[]>>={
  tickets:["servicenow","jira"], changes:["servicenow","github"],offboarding:["servicenow","entra"],cmdb:["servicenow","aws"],sla:["servicenow"],
};
export async function connectionTest(con:Connection) {
  approvedHost(con.provider,con.host);
  switch(con.provider) {
    case "servicenow": {
      const auth=await serviceAuth(con);
      const sample=typeof con.settings.sampleIncident==="string"?con.settings.sampleIncident:"";
      if(!/^[0-9a-f]{32}$/i.test(sample)) throw new ProviderError("sample_incident_required");
      const row=await serviceGet(con,auth,"incident",sample,["sys_id","number","state","priority","assignment_group","sys_updated_on"]);
      if(!row?.sys_id||!row.number||!row.state||!row.priority||!row.assignment_group||!row.sys_updated_on) throw new ProviderError("required_fields_not_visible");
      return {scope:"sample incident",sample:row.number};
    }
    case "jira": {
      const {base,headers}=await jiraAuth(con);
      const issue=typeof con.settings.sampleIssue==="string"?con.settings.sampleIssue:"";
      if(!/^[A-Z][A-Z0-9]+-\d+$/.test(issue)) throw new ProviderError("sample_issue_required");
      const r=await providerRequest<Json>(new URL(base+"/rest/api/3/issue/"+issue+"?fields=project,status"),{headers});
      if(!r.data.id||!obj(r.data.fields).status) throw new ProviderError("required_fields_not_visible");
      return {scope:"sample issue",sample:r.data.key};
    }
    case "github": {
      const auth=bearer(githubCredentials.parse(secrets(con)).token);
      const repo=z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).parse(con.settings.repository);
      await providerRequest(new URL(con.host+"/repos/"+repo+"/deployments?per_page=1"),{headers:auth});
      return {scope:"deployments",sample:repo};
    }
    case "entra": {
      const auth=await entraAuth(con);
      const userId=z.uuid().parse(con.settings.sampleUser);
      const result=await providerRequest<Json>(new URL(con.host+"/v1.0/users/"+userId+"?$select=id,accountEnabled"),{headers:auth});
      if(typeof result.data.accountEnabled!=="boolean") throw new ProviderError("required_fields_not_visible");
      return {scope:"user account state"};
    }
    case "aws": {
      const region=z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/).parse(con.settings.region);
      const ec2=new EC2Client({region,credentials:awsCredentials.parse(secrets(con)),maxAttempts:2});
      try {await ec2.send(new DescribeInstancesCommand({MaxResults:5}),{abortSignal:AbortSignal.timeout(18000)});}
      finally {ec2.destroy();}
      return {scope:"EC2 inventory",sample:region};
    }
  }
}
async function entraAuth(con:Connection) {
  const creds=entraCredentials.parse(secrets(con));
  return bearer(await formToken("https://login.microsoftonline.com/"+creds.directoryId+"/oauth2/v2.0/token",{grant_type:"client_credentials",
    client_id:creds.clientId,client_secret:creds.clientSecret,scope:"https://graph.microsoft.com/.default"}));
}
function filteredServiceScope(since:Date){return "sys_updated_on>="+utc(since);}
export async function collectLive(module:ModuleId, config:Config, cons:Connection[], clock:Date, baseline=false):Promise<unknown> {
  const sn=need(cons,"servicenow"),snAuth=await serviceAuth(sn);
  switch(module) {
    case "tickets": {
      const s=liveSchema.tickets.parse(config.settings),since=deadline(baseline?30:s.lookbackDays);
      const jira=need(cons,"jira");
      if(sn.health==="untested"||jira.health==="untested") throw new ProviderError("connections_must_be_tested");
      const [rawIncidents,rawIssues]=await Promise.all([
        serviceTable(sn,snAuth,"incident","assignment_group="+s.groupId+"^"+filteredServiceScope(since)+"^sys_updated_on<="+utc(clock),
          ["number","sys_created_on","sys_updated_on","state","priority","assignment_group",s.sourceField,...(s.eligibleField?[s.eligibleField]:[])],s.maxRecords),
        jiraSearch(jira,s),
      ]);
      if(rawIncidents.some(x=>ref(x.assignment_group)!==s.groupId||!text(x.number)||!text(x.priority)||!time(x.sys_updated_on))) throw new ProviderError("servicenow_scope_or_field_visibility");
      const incidents=rawIncidents.filter(x=>s.includedPriorities.includes(x.priority as never))
        .map(x=>({id:String(x.sys_id),number:String(x.number),correlation:normalize(x[s.sourceField]),state:stable(x.state)??null,
          priority:String(x.priority),eligibleAt:time(s.eligibleField?x[s.eligibleField]:undefined),
          createdAt:validDate(x.sys_created_on),updatedAt:validDate(x.sys_updated_on),url:link(sn.host,"incident",String(x.sys_id))}));
      const issues=rawIssues.map(x=>{
        const fields=obj(x.fields);
        return {id:String(x.id),key:String(x.key),correlation:normalize(fields[s.jiraField]),status:stable(obj(fields.status).id)??null,
          updatedAt:validDate(fields.updated),url:jira.host+"/browse/"+encodeURIComponent(String(x.key))};
      });
      const jiraSample=typeof jira.settings.sampleIssue==="string"&&/^[A-Z][A-Z0-9]+-\d+$/.test(jira.settings.sampleIssue)?jira.settings.sampleIssue:undefined;
      if(!jiraSample) throw new ProviderError("sample_issue_required");
      const {base,headers}=await jiraAuth(jira);
      const probe=(await providerRequest<Json>(new URL(base+"/rest/api/3/issue/"+jiraSample+"?fields=project,status,"+s.jiraField),{headers})).data;
      const fields=obj(probe.fields);
      const coverage=stable(obj(fields.project).id)===s.projectId&&normalize(fields[s.jiraField])!==null&&Boolean(stable(obj(fields.status).id));
      return {incidents,issues,statusMap:s.statusMap,coverage};
    }
    case "changes": {
      const s=liveSchema.changes.parse(config.settings),github=need(cons,"github"),headers=bearer(githubCredentials.parse(secrets(github)).token);
      const deployments=[];
      let done=false;
      for(let page=1;page<=10;page++){
        const url=new URL(github.host+"/repos/"+s.repository+"/deployments");
        url.search=new URLSearchParams({environment:s.environment,per_page:"50",page:String(page)}).toString();
        const batch=array((await providerRequest<unknown>(url,{headers})).data);
        for(const item of batch){
          if(Date.parse(validDate(item.created_at))<deadline(s.lookbackDays).getTime()) continue;
          const id=stable(item.id);
          if(!id) continue;
          const states=array((await providerRequest<unknown>(new URL(github.host+"/repos/"+s.repository+"/deployments/"+id+"/statuses?per_page=30"),{headers})).data);
          const success=states.filter(x=>x.state==="success").at(-1);
          if(!success) continue;
          const payload=typeof item.payload==="string" ? (()=>{try{return obj(JSON.parse(item.payload));}catch{return {};}})() : obj(item.payload);
          deployments.push({id,name:typeof item.ref==="string"?item.ref:"GitHub deployment "+id,time:validDate(success.created_at),
            changeId:text(payload.changeId),emergency:payload.emergency===true,
            url:"https://github.com/"+s.repository+"/deployments"});
        }
        if(batch.length<50||batch.some(x=>Date.parse(validDate(x.created_at))<deadline(s.lookbackDays).getTime())) {done=true;break;}
        if(Date.now()-clock.getTime()>150000) throw new ProviderError("provider_scan_deadline");
      }
      if(!done) throw new ProviderError("scope_record_limit");
      const changes=await serviceTable(sn,snAuth,"change_request",filteredServiceScope(deadline(s.lookbackDays+30)),[s.changeField,s.approvalTimeField,"approval"],2000);
      return {complete:true,deployments,approvals:changes.flatMap(x=>text(x[s.changeField]) ?
        [{id:x[s.changeField],approved:x.approval==="approved",time:time(x[s.approvalTimeField]),url:link(sn.host,"change_request",String(x.sys_id))}]:[])};
    }
    case "offboarding": {
      const s=liveSchema.offboarding.parse(config.settings),entra=need(cons,"entra"),headers=await entraAuth(entra);
      const tasks=await serviceTable(sn,snAuth,"sc_task","active=false^assignment_group="+s.groupId+"^"+filteredServiceScope(deadline(s.lookbackDays)),
        [s.identityField,s.dueField,"active"],250);
      const exits=[];
      for(const x of tasks) {
        const identity=text(x[s.identityField]), dueAt=time(x[s.dueField]);
        if(!dueAt) throw new ProviderError("offboarding_due_missing");
        let accountEnabled:boolean|null=null,remainingApps:string[]|null=null;
        if(identity&&z.uuid().safeParse(identity).success) {
          try {
            const profile=(await providerRequest<Json>(new URL(entra.host+"/v1.0/users/"+identity+"?$select=id,accountEnabled"),{headers})).data;
            accountEnabled=typeof profile.accountEnabled==="boolean"?profile.accountEnabled:null;
            if(!s.appResourceIds.length) remainingApps=[];
            else {
              let next:string|undefined=entra.host+"/v1.0/users/"+identity+"/appRoleAssignments?$select=resourceId";
              const found=new Set<string>();
              for(let page=0;next&&page<20;page++){
                const u:URL=new URL(next);
                if(u.origin!==entra.host||u.pathname!=="/v1.0/users/"+identity+"/appRoleAssignments") throw new ProviderError("provider_pagination_inconsistent");
                const result:Json=(await providerRequest<Json>(u,{headers})).data;
                for(const a of array(result.value)) if(typeof a.resourceId==="string"&&s.appResourceIds.includes(a.resourceId)) found.add(a.resourceId);
                next=text(result["@odata.nextLink"]);
              }
              if(!next) remainingApps=[...found];
            }
          } catch(e) {if(!(e instanceof ProviderError)||!["provider_permission","provider_not_found"].includes(e.code)) throw e;}
        }
        exits.push({id:String(x.sys_id),dueAt,completed:!bool(x.active),accountEnabled,remainingApps,url:link(sn.host,"sc_task",String(x.sys_id))});
        if(Date.now()-clock.getTime()>150000) throw new ProviderError("provider_scan_deadline");
      }
      return {exits};
    }
    case "cmdb": {
      const s=liveSchema.cmdb.parse(config.settings),aws=need(cons,"aws");
      const ec2=new EC2Client({region:s.region,credentials:awsCredentials.parse(secrets(aws)),maxAttempts:2});
      const cloud=[];
      let NextToken:string|undefined;
      try {
        do {
          const response=await ec2.send(new DescribeInstancesCommand({MaxResults:200,NextToken}),{abortSignal:AbortSignal.timeout(18000)});
          for(const reservation of response.Reservations??[]) for(const instance of reservation.Instances??[]){
            if(instance.InstanceId) cloud.push({id:instance.InstanceId,
              state:["terminated","shutting-down"].includes(instance.State?.Name??"")?"retired":"active",
              owner:instance.Tags?.find(tag=>tag.Key===s.ownerTag)?.Value});
          }
          NextToken=response.NextToken;
          if(cloud.length>5000) throw new ProviderError("scope_record_limit");
        } while(NextToken);
      } finally {ec2.destroy();}
      const cmdb=await serviceTable(sn,snAuth,s.className,s.scopeField+"="+s.scopeValue,[s.resourceField,"owned_by","install_status"],5000);
      if(cmdb.some(x=>!text(x[s.resourceField]))) throw new ProviderError("resource_field_not_visible");
      return {complete:true,cloud,cmdb:cmdb.map(x=>({id:String(x.sys_id),resourceId:x[s.resourceField],owner:ref(x.owned_by),
        state:x.install_status==="7"?"retired":"active",url:link(sn.host,s.className,String(x.sys_id))}))};
    }
    case "sla": {
      const s=liveSchema.sla.parse(config.settings);
      const tasks=await serviceTable(sn,snAuth,"task_sla","sla="+s.slaId+"^"+filteredServiceScope(deadline(7))+"^NQsla="+s.slaId+"^active=true",["planned_end_time","stage","active","task"],3000);
      const normalized=tasks.flatMap(x=>{
        const due=time(x.planned_end_time), id=text(x.sys_id);
        if(!due||!id) return [];
        return [{id,deadline:due,paused:x.stage==="paused",closed:!bool(x.active),url:link(sn.host,"task_sla",id)}];
      });
      if(normalized.length!==tasks.length) throw new ProviderError("sla_deadline_not_visible");
      return {minutes:s.minutes,tasks:normalized};
    }
    default: throw new ProviderError("evidence_required");
  }
}

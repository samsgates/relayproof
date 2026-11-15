"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, LoaderCircle, LogOut, Menu, Plus, RefreshCw, X } from "lucide-react";
import { Brand, Icon, Badge, Evidence } from "./presentation";
import { modules, type ModuleId } from "@/lib/catalog";
import { example, liveExamples } from "@/lib/examples";
import type { Config } from "@/lib/rules";

export async function call(path:string,data:unknown,method="POST",idempotent=false){
  const response=await fetch(path,{method,headers:{"Content-Type":"application/json",...(idempotent?{"Idempotency-Key":crypto.randomUUID()}:{})},body:JSON.stringify(data)});
  const j=await response.json();
  if(!response.ok)throw new Error(j.message??"Request could not be completed.");
  return j;
}
function Status({error,success}:{error:string;success?:string}){
  return <>{error&&<div className="form-message error" role="alert">{error}</div>}{success&&<div className="form-message success" role="status"><Check size={16}/>{success}</div>}</>;
}
function useTask(){
  const [busy,setBusy]=useState(false), [error,setError]=useState(""), [success,setSuccess]=useState("");
  async function run(fn:()=>Promise<unknown>, message=""){
    if(busy)return;
    setBusy(true);setError("");setSuccess("");
    try {const result=await fn();setSuccess(message);return result;}
    catch(e){setError(e instanceof Error?e.message:"The request failed.");}
    finally{setBusy(false);}
  }
  return {busy,error,success,run};
}
function Busy({busy,label}:{busy:boolean;label:string}) {return <>{busy?<LoaderCircle className="spin" size={16}/>:null}{label}</>;}
function values(e:FormEvent<HTMLFormElement>){ e.preventDefault();return Object.fromEntries(new FormData(e.currentTarget));}

export function LoginForm({signup,sso,next}:{signup:boolean;sso:boolean;next?:string}){
  const [register,setRegister]=useState(false), [ready,setReady]=useState(false), task=useTask();
  useEffect(()=>setReady(true),[]);
  async function submit(e:FormEvent<HTMLFormElement>){
    const data=values(e);
    await task.run(async()=>{const r=await call("/api/auth/"+(register?"register":"login"),data);window.location.assign(next||r.next);});
  }
  return <><h1>{register?"Create your account":"Sign in to RelayProof"}</h1><p>Access your organization’s monitoring workspace.</p>
    {sso&&<a className="button secondary fill" href={"/api/auth/workos"+(next?"?next="+encodeURIComponent(next):"")}>Continue with enterprise SSO <ArrowUpRight size={16}/></a>}
    <form className="form-stack" method="post" onSubmit={submit}>
      {register&&<label>Full name<input name="name" autoComplete="name" required minLength={2}/></label>}
      <label>Work email<input type="email" name="email" placeholder="you@company.com" autoComplete="email" required/></label>
      <label>Password<input type="password" name="password" minLength={12} autoComplete={register?"new-password":"current-password"} required/></label>
      <Status error={task.error}/>
      <button className="button primary fill" disabled={!ready||task.busy}><Busy busy={task.busy} label={register?"Create account":"Sign in"}/><ArrowRight size={17}/></button>
    </form>
    {signup&&<button className="bare account-switch" onClick={()=>setRegister(!register)}>{register?"Already have an account? Sign in":"Create a workspace account"}</button>}
  </>;
}
export function SetupForm(){
  const task=useTask();
  function submit(e:FormEvent<HTMLFormElement>){
    const data=values(e);
    void task.run(async()=>{const r=await call("/api/v1/organizations",data);window.location.assign("/w/"+r.workspace);});
  }
  return <><h1>Create your workspace</h1><p>Set up your organization and choose the time zone for dates and reports.</p>
    <form className="form-stack" method="post" onSubmit={submit}>
      <label>Organization name<input name="name" required minLength={2} placeholder="Acme Operations"/></label>
      <label>Time zone<input name="timezone" defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC"} required/></label>
      <Status error={task.error}/><button className="button primary" disabled={task.busy}><Busy busy={task.busy} label="Create workspace"/><ArrowRight size={16}/></button>
    </form></>;
}
export function AcceptInvite({tenant,workspace,inviteToken,loggedIn,returnTo}:{tenant:string;workspace:string;inviteToken:string;loggedIn:boolean;returnTo:string}){
  const task=useTask();
  return <><h1>Join your workspace</h1><p>Sign in with the email address your administrator invited.</p>
    {!loggedIn?<Link className="button primary" href={"/login?next="+encodeURIComponent(returnTo)}>Sign in <ArrowRight size={16}/></Link>:
     <button className="button primary" disabled={task.busy} onClick={()=>void task.run(async()=>{await call("/api/v1/invite",{tenant,workspace,token:inviteToken});window.location.assign("/w/"+workspace);})}><Busy busy={task.busy} label="Accept invitation"/></button>}
     <Status error={task.error}/>
  </>;
}
export function Shell({children,workspace,name,organization,username,role,active,scopes}:{children:ReactNode;workspace:string;name:string;organization:string;username:string;role:string;active:string;scopes:{workspace:string;name:string;organization:string}[]}){
  const router=useRouter(), [mobile,setMobile]=useState(false);
  const nav=[["overview","Overview"],["exceptions","Exceptions"],["rules","Rules"],["connections","Connections"],["modules","Modules"],["reports","Reports & audit"],["settings","Settings"]];
  const path="/w/"+workspace;
  return <div className="shell">
    {mobile&&<button className="overlay" aria-label="Close navigation" onClick={()=>setMobile(false)}/>}
    <aside className={"sidebar"+(mobile?" visible":"")}>
      <Link href={path} className="side-brand" onClick={()=>setMobile(false)}><Brand/></Link>
      <div className="workspace-picker"><div className="workspace-avatar">{organization[0]?.toUpperCase()??"R"}</div><div><strong>{organization}</strong><small>{name}</small></div><ChevronDown size={15}/>
        {scopes.length>1&&<select aria-label="Switch workplace" value={workspace} onChange={e=>{setMobile(false);router.push("/w/"+e.target.value);}}>{scopes.map(s=><option value={s.workspace} key={s.workspace}>{s.organization} / {s.name}</option>)}</select>}</div>
      <div className="nav-label">Workspace</div>
      <nav aria-label="Workspace navigation">{nav.map(([section,label])=><Link key={section} className={"nav-link "+(active===section?"selected":"")} aria-current={active===section?"page":undefined}
        href={section==="overview"?path:path+"/"+section} onClick={()=>setMobile(false)}><Icon name={section}/><span>{label}</span></Link>)}</nav>
      <div className="side-bottom">
        <Link href={path+"/help"} className="nav-link" onClick={()=>setMobile(false)}><CircleHelp size={18}/> Setup guide</Link>
        <div className="account"><span className="avatar">{username.slice(0,2).toUpperCase()}</span><span><strong>{username}</strong><small>{role}</small></span>
          <button className="icon-button" title="Sign out" aria-label="Sign out" onClick={async()=>{try{await call("/api/auth/logout",{});window.location.assign("/login");}catch{router.refresh();}}}><LogOut size={17}/></button></div>
      </div>
    </aside>
    <div className="shell-body">
      <header className="topbar"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={()=>setMobile(true)}><Menu size={22}/></button>
        <div className="crumb"><span>Workspace</span><span>/</span><strong>{nav.find(x=>x[0]===active)?.[1]??"Setup guide"}</strong></div>
        <div className="top-actions"><button className="icon-button" title="Refresh workspace" aria-label="Refresh workspace" onClick={()=>router.refresh()}><RefreshCw size={17}/></button>
          <Link href={path+"/connections"} className="top-status"><span/><span>Connection status</span></Link></div>
      </header>
      <main className="main" id="main">{children}</main>
    </div>
  </div>;
}
export function Command({endpoint,body={},label,kind="secondary",confirm}:{endpoint:string;body?:unknown;label:string;kind?:string;confirm?:string}){
  const task=useTask(), router=useRouter();
  return <div className="command"><button type="button" className={"button "+kind} disabled={task.busy}
    onClick={()=>{if(!confirm||window.confirm(confirm))void task.run(async()=>{await call(endpoint,body,"POST",true);router.refresh();},"Request accepted.");}}><Busy busy={task.busy} label={label}/></button>
    <Status error={task.error} success={task.success}/></div>;
}
export function ConnectionForm({base,oauth}:{base:string;oauth:boolean}){
  const [provider,setProvider]=useState("servicenow");
  const task=useTask(),router=useRouter();
  const providerList={servicenow:"ServiceNow",jira:"Jira Cloud",github:"GitHub",entra:"Microsoft Entra ID",aws:"Amazon Web Services"};
  const fields:Record<string,{key:string;label:string;placeholder?:string;password?:boolean;optional?:boolean}[]>={
    servicenow:[{key:"host",label:"Instance URL",placeholder:"https://company.service-now.com"},{key:"sampleIncident",label:"Sample incident sys_id"},{key:"clientId",label:"OAuth client ID"},{key:"clientSecret",label:"OAuth client secret",password:true}],
    jira:[{key:"host",label:"Site URL",placeholder:"https://company.atlassian.net"},{key:"sampleIssue",label:"Sample issue with a correlation value",placeholder:"OPS-123"},{key:"email",label:"Integration account email"},{key:"token",label:"API token",password:true}],
    github:[{key:"repository",label:"Repository",placeholder:"owner/repo"},{key:"token",label:"Read-only GitHub token",password:true}],
    entra:[{key:"directoryId",label:"Directory tenant ID"},{key:"sampleUser",label:"Sample user object ID"},{key:"clientId",label:"Application ID"},{key:"clientSecret",label:"Application secret",password:true}],
    aws:[{key:"region",label:"Region",placeholder:"ap-south-1"},{key:"accessKeyId",label:"Access key ID"},{key:"secretAccessKey",label:"Secret key",password:true},{key:"sessionToken",label:"Session token",password:true,optional:true}],
  };
  function submit(e:FormEvent<HTMLFormElement>){
    const form=e.currentTarget,data=values(e);
    const action=(e.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
    if(action==="oauth"){
      const params=new URLSearchParams({host:String(data.host),sampleIssue:String(data.sampleIssue)});
      window.location.assign(base+"/jira-oauth/start?"+params);return;
    }
    const {host,sampleIncident,sampleIssue,repository,sampleUser,region,...credentials}=data;
    if(!credentials.sessionToken)delete credentials.sessionToken;
    void task.run(async()=>{
      await call(base+"/connections",{provider,host,label:providerList[provider as keyof typeof providerList],
        settings:{sampleIncident,sampleIssue,repository,sampleUser,region},credentials:{...credentials,...(provider==="jira"?{mode:"token"}:{})}});
      form.reset();router.refresh();
    },"Connection saved. Run a connection test.");
  }
  return <form className="form-stack" method="post" onSubmit={submit}>
    <label>Provider<select value={provider} onChange={e=>setProvider(e.target.value)}>{Object.entries(providerList).map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></label>
    <div key={provider} className="fields">{fields[provider].map(f=><label key={f.key}>{f.label}<input name={f.key} placeholder={f.placeholder} type={f.password?"password":"text"} autoComplete="off" required={!f.optional}/></label>)}</div>
    <div className="form-actions"><button className="button primary" disabled={task.busy}><Busy busy={task.busy} label="Save connection"/></button>
      {provider==="jira"&&oauth&&<button className="button secondary" formNoValidate value="oauth">Authorize with Jira <ArrowUpRight size={15}/></button>}</div>
    <Status error={task.error} success={task.success}/>
  </form>;
}
export function RuleForm({base,rule,defaultModule,owners=[]}:{base:string;rule?:{id:string;name:string;module:string;draft:unknown};defaultModule?:ModuleId;owners?:{id:string;name:string}[]}){
  const config=rule?.draft as Config|undefined;
  const task=useTask(), router=useRouter();
  const [module,setModule]=useState<ModuleId>((rule?.module as ModuleId|undefined)??defaultModule??"tickets");
  const [mode,setMode]=useState(config?.source??"evidence");
  const [settings,setSettings]=useState(config?.source==="live"?JSON.stringify(config.settings,null,2):"{}");
  const endpoint=base+"/rules"+(rule?"/"+rule.id+"/draft":"");
  function submit(e:FormEvent<HTMLFormElement>){
    const f=values(e);
    void task.run(async()=>{
      const cs={source:mode,intervalMinutes:Number(f.interval),graceMinutes:Number(f.grace),severity:f.severity,ownerId:f.ownerId||undefined,settings:mode==="live"?JSON.parse(settings):{}};
      const result=await call(endpoint,{name:f.name,module,config:cs});
      if(result.id) router.push(base.replace("/api/v1/workspaces","/w")+"/rules/"+result.id);
      router.refresh();
    },"Draft saved.");
  }
  return <form className="form-stack" method="post" onSubmit={submit}>
    <label>Rule name<input name="name" defaultValue={rule?.name??(defaultModule?modules.find(m=>m.id===defaultModule)?.name:"")} required minLength={2} maxLength={100}/></label>
    <div className="fields"><label>Module<select disabled={Boolean(rule)} value={module} onChange={e=>{setModule(e.target.value as ModuleId);if(!(e.target.value in liveExamples))setMode("evidence");}}>
      {modules.map(m=><option value={m.id} key={m.id}>{m.name}</option>)}</select></label>
      <label>Input mode<select value={mode} onChange={e=>setMode(e.target.value as Config["source"])}>
        <option value="evidence">Reviewed evidence</option>{module in liveExamples&&<option value="live">Live connectors</option>}</select></label></div>
    <div className="fields triple"><label>Severity<select name="severity" defaultValue={config?.severity??"high"}>{["critical","high","medium","low"].map(s=><option key={s}>{s}</option>)}</select></label>
      <label>Poll interval in minutes<input name="interval" type="number" defaultValue={config?.intervalMinutes??5} min={5} max={1440} required/></label>
      <label>Grace period in minutes<input name="grace" type="number" defaultValue={config?.graceMinutes??15} min={0} max={1440} required/></label></div>
    <label>Default owner<select name="ownerId" defaultValue={config?.ownerId??""}><option value="">Unassigned</option>{owners.map(owner=><option key={owner.id} value={owner.id}>{owner.name}</option>)}</select></label>
    {mode==="live"&&<><label>Provider field mappings and scope<textarea value={settings} onChange={e=>setSettings(e.target.value)} rows={9} spellCheck={false} required/></label>
      <button className="button secondary" type="button" onClick={()=>setSettings(JSON.stringify(liveExamples[module as keyof typeof liveExamples],null,2))}>Load configuration template</button></>}
    <button className="button primary" disabled={task.busy}><Busy busy={task.busy} label="Save draft"/></button>
    <Status error={task.error} success={task.success}/>
  </form>;
}
export function EvidenceForm({base,rule,module}:{base:string;rule:string;module:ModuleId}){
  const [sample,setSample]=useState(""), [result,setResult]=useState<unknown>(), task=useTask();
  function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const target=(e.nativeEvent as SubmitEvent).submitter?.getAttribute("value")??"preview";
    void task.run(async()=>{const data=await call(base+"/rules/"+rule+"/"+target,{sample:JSON.parse(sample)});setResult(target==="preview"?data:undefined);},target==="preview"?"Preview generated.":"Evidence saved. Run the published rule to apply it.");
  }
  return <form className="form-stack" method="post" onSubmit={submit}>
    <label>Approved evidence JSON<textarea rows={9} value={sample} onChange={e=>setSample(e.target.value)} required spellCheck={false} placeholder="Paste JSON or load sample evidence"/></label>
    <div className="form-actions"><button type="button" className="button secondary" onClick={()=>setSample(JSON.stringify(example(module),null,2))}>Load example</button>
      <button className="button secondary" value="preview" disabled={task.busy}><Busy busy={task.busy} label="Preview"/></button>
      <button className="button primary" value="evidence" disabled={task.busy}><Busy busy={task.busy} label="Save evidence"/></button></div>
    <Status error={task.error} success={task.success}/>{result!==undefined&&<div className="evidence-preview"><Evidence data={result}/></div>}
  </form>;
}
export function ExceptionForm({endpoint,version,closed,owners}:{endpoint:string;version:number;closed:boolean;owners:{id:string;name:string}[]}){
  const task=useTask(),router=useRouter(),[action,setAction]=useState(closed?"comment":"acknowledge");
  function submit(e:FormEvent<HTMLFormElement>){
    const f=values(e);
    void task.run(async()=>{
      await call(endpoint,{version,action,ownerId:f.ownerId||null,note:f.note||undefined,until:f.until?new Date(String(f.until)).toISOString():undefined},"PATCH");
      router.refresh();
    },"Exception updated.");
  }
  return <form className="form-stack" method="post" onSubmit={submit}>
    <label>Action<select value={action} onChange={e=>setAction(e.target.value)}>
      {(closed?["comment"]:["acknowledge","assign","suppress","dismiss","comment"]).map(a=><option value={a} key={a}>{a[0].toUpperCase()+a.slice(1)}</option>)}</select></label>
    {action==="assign"&&<label>Owner<select name="ownerId"><option value="">Unassigned</option>{owners.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label>}
    {action==="suppress"&&<label>Suppress until<input type="datetime-local" name="until" required/></label>}
    {["dismiss","comment","suppress"].includes(action)&&<label>Reason or comment<textarea name="note" required minLength={2} maxLength={500} rows={3}/></label>}
    <button className="button primary" disabled={task.busy}><Busy busy={task.busy} label="Update exception"/></button><Status error={task.error} success={task.success}/>
  </form>;
}
export function SettingsForm({base,name,timezone,state,alertEmails}:{base:string;name:string;timezone:string;state:string;alertEmails:boolean}){
  const task=useTask(), router=useRouter();
  function submit(e:FormEvent<HTMLFormElement>){
    const f=values(e);void task.run(async()=>{await call(base+"/settings",{name:f.name,timezone:f.timezone,state:f.state,alertEmails:f.alertEmails==="on"});router.refresh();},"Settings updated.");
  }
  return <form className="form-stack" method="post" onSubmit={submit}><div className="fields"><label>Workspace name<input name="name" defaultValue={name} required minLength={2}/></label>
    <label>Time zone<input name="timezone" defaultValue={timezone} required/></label></div>
    <label>Monitoring state<select name="state" defaultValue={state}><option value="setup">Setup</option><option value="active">Active</option><option value="paused">Paused</option></select></label>
    <label className="check-label"><input name="alertEmails" type="checkbox" defaultChecked={alertEmails}/> Email alerts to workspace operators and admins</label>
    <button className="button primary" disabled={task.busy}><Busy busy={task.busy} label="Save settings"/></button><Status error={task.error} success={task.success}/>
  </form>;
}
export function InviteForm({base}:{base:string}){
  const task=useTask(),[link,setLink]=useState("");
  function submit(e:FormEvent<HTMLFormElement>){const f=values(e);void task.run(async()=>{const r=await call(base+"/members",f);setLink(r.link);},"Invitation created. Share the link with the intended recipient.");}
  return <form className="form-stack" method="post" onSubmit={submit}><div className="fields"><label>Work email<input name="email" type="email" required/></label>
    <label>Role<select name="role"><option>operator</option><option>viewer</option><option>auditor</option><option>admin</option></select></label></div>
    <button className="button primary" disabled={task.busy}><Busy busy={task.busy} label="Create invite link"/></button><Status error={task.error} success={task.success}/>
    {link&&<label>Private invitation link<input readOnly value={link} onFocus={e=>e.currentTarget.select()}/></label>}
  </form>;
}
export function WorkspaceForm({base}:{base:string}){
  const task=useTask(),router=useRouter();
  function submit(e:FormEvent<HTMLFormElement>){const f=values(e);void task.run(async()=>{const r=await call(base+"/workspaces",f);router.push("/w/"+r.id);router.refresh();});}
  return <form className="form-stack" method="post" onSubmit={submit}><div className="fields"><label>Workspace name<input name="name" minLength={2} required/></label>
    <label>Time zone<input name="timezone" defaultValue="UTC" required/></label></div><button className="button secondary" disabled={task.busy}><Plus size={16}/><Busy busy={task.busy} label="Add workspace"/></button><Status error={task.error}/></form>;
}
export function Filter({href,filters,rules,people}:{href:string;filters:Record<string,string|undefined>;rules:{id:string;name:string}[];people:{id:string;name:string}[]}){
  return <form className="filters" action={href}>
    <label>Status<select name="state" defaultValue={filters.state??""}><option value="">All statuses</option>{["open","acknowledged","suppressed","resolved","dismissed"].map(s=><option key={s} value={s}>{s}</option>)}</select></label>
    <label>Severity<select name="severity" defaultValue={filters.severity??""}><option value="">All severities</option>{["critical","high","medium","low"].map(s=><option key={s} value={s}>{s}</option>)}</select></label>
    <label>Rule<select name="rule" defaultValue={filters.rule??""}><option value="">All rules</option>{rules.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
    <label>Owner<select name="owner" defaultValue={filters.owner??""}><option value="">All owners</option><option value="unassigned">Unassigned</option>{people.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
    <label>From<input type="date" name="from" defaultValue={filters.from}/></label><label>Through<input type="date" name="to" defaultValue={filters.to}/></label>
    <button className="button secondary">Apply filters</button><Link href={href} className="reset" aria-label="Clear filters"><X size={16}/> Clear</Link>
  </form>;
}

export function DeletionForm({base,organization}:{base:string;organization:string}){
  const task=useTask(),router=useRouter();
  function submit(e:FormEvent<HTMLFormElement>){
    const data=values(e);
    void task.run(async()=>{await call(base+"/settings/delete",data);router.refresh();},
      "Deletion requested. Scheduled monitoring has been paused.");
  }
  return <form className="form-stack" method="post" onSubmit={submit}>
    <label>Type {organization} to request deletion<input name="organization" required autoComplete="off"/></label>
    <button className="button secondary" disabled={task.busy}><Busy busy={task.busy} label="Request deletion"/></button>
    <Status error={task.error} success={task.success}/>
  </form>;
}

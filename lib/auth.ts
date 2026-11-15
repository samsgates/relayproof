import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { WorkOS } from "@workos-inc/node";
import { audit, one, pool, transaction, type Tx } from "./db";

const scrypt = promisify(scryptCallback);
export const sessionCookie = "relay_session";
export const securityCookie = {httpOnly:true, sameSite:"lax" as const, secure:process.env.COOKIE_SECURE !== "false", path:"/"};
export const roles = ["owner","admin","operator","viewer","auditor"] as const;
export type Role = typeof roles[number];
export type User = {id:string; email:string; name:string};
export type Scope = {tenant:string; workspace:string; role:Role; user:User; tenantRole:Role; name:string; organization:string; timezone:string; state:string; alert_emails:boolean};
export class HttpError extends Error {
  constructor(public status:number, public code:string, message:string) {super(message);}
}
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const hash = (value:string) => createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export function origin() {
  const url = new URL(process.env.APP_URL ?? "http://localhost:3000");
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:" && process.env.COOKIE_SECURE !== "false")
    throw new Error("Production APP_URL requires HTTPS");
  return url.origin;
}
export function checkOrigin(request:Request) {
  if (request.headers.get("origin") !== origin()) throw new HttpError(403,"origin","The request origin could not be verified.");
}
export async function passwordHash(password:string) {
  const salt = randomBytes(16).toString("hex");
  const result = await scrypt(password,salt,64) as Buffer;
  return salt + ":" + result.toString("hex");
}
export async function verifyPassword(password:string, encoded:string | null | undefined) {
  const candidate = encoded ?? ("0".repeat(32) + ":" + "0".repeat(128));
  const [salt, digest] = candidate.split(":");
  const computed = await scrypt(password,salt,64) as Buffer;
  const wanted = Buffer.from(digest,"hex");
  return Boolean(encoded) && computed.length === wanted.length && timingSafeEqual(computed,wanted);
}
export async function throttle(key:string, limit:number, seconds:number) {
  const row = (await pool().query<{count:number}>(`INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+$2*interval '1 second')
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<=now() THEN 1 ELSE LEAST(rate_limits.count+1,100000) END,
    expires_at=CASE WHEN rate_limits.expires_at<=now() THEN excluded.expires_at ELSE rate_limits.expires_at END RETURNING count`,[hash(key),seconds])).rows[0];
  if (row.count > limit) throw new HttpError(429,"rate_limit","Too many attempts. Try again later.");
}
export async function startSession(user:string) {
  const value = token();
  await pool().query("INSERT INTO sessions(digest,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')",[hash(value),user]);
  (await cookies()).set(sessionCookie,value,{...securityCookie,maxAge:43200});
}
export async function endSession() {
  const jar = await cookies();
  const raw = jar.get(sessionCookie)?.value;
  if (raw) await pool().query("DELETE FROM sessions WHERE digest=$1",[hash(raw)]);
  jar.set(sessionCookie,"",{...securityCookie,maxAge:0});
}
export async function currentUser() {
  const raw = (await cookies()).get(sessionCookie)?.value;
  if (!raw) return undefined;
  return (await pool().query<User>(`SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.digest=$1 AND s.expires_at>now()`,[hash(raw)])).rows[0];
}
export async function findScopes(user:User):Promise<Scope[]> {
  const organizations = await transaction(null,user.id,async client=>(await client.query<{tenant_id:string}>("SELECT tenant_id FROM memberships WHERE user_id=$1",[user.id])).rows);
  const result:Scope[]=[];
  for (const {tenant_id} of organizations) result.push(...await transaction(tenant_id,user.id,async client=>{
    const rows=(await client.query<Omit<Scope,"user">>(`SELECT w.tenant_id AS tenant,w.id AS workspace,w.name,w.timezone,w.state,w.alert_emails,o.name AS organization,
      m.role AS "tenantRole",CASE WHEN m.role='owner' THEN 'owner' ELSE wm.role END AS role
      FROM workspaces w JOIN organizations o ON o.id=w.tenant_id JOIN memberships m ON m.tenant_id=w.tenant_id AND m.user_id=$1
      LEFT JOIN workspace_memberships wm ON wm.tenant_id=w.tenant_id AND wm.workspace_id=w.id AND wm.user_id=m.user_id
      WHERE o.status<>'deleting' AND (m.role='owner' OR wm.role IS NOT NULL) ORDER BY w.name`,[user.id])).rows;
    return rows.map(r=>({...r,user}));
  }));
  return result;
}
export async function getScope(user:User, workspace?:string) {
  const scopes = await findScopes(user);
  return workspace ? scopes.find(scope=>scope.workspace===workspace) : scopes[0];
}
export function requireRole(scope:Scope, allowed:Role[]) {
  if (!allowed.includes(scope.role)) throw new HttpError(403,"forbidden","Your workspace role cannot perform this action.");
}
export async function inScope<T>(scope:Scope, callback:(client:Tx)=>Promise<T>) {
  return transaction(scope.tenant,scope.user.id,async client=>{
    const role=await one<{role:Role}>(client,`SELECT CASE WHEN m.role='owner' THEN 'owner' ELSE wm.role END role
      FROM memberships m JOIN organizations o ON o.id=m.tenant_id
      LEFT JOIN workspace_memberships wm ON wm.tenant_id=m.tenant_id AND wm.user_id=m.user_id AND wm.workspace_id=$2
      WHERE m.user_id=$1 AND m.tenant_id=$3 AND o.status<>'deleting'`,[scope.user.id,scope.workspace,scope.tenant]);
    if (role?.role !== scope.role) throw new HttpError(403,"scope_changed","Workspace access changed. Refresh and retry.");
    return callback(client);
  });
}
export async function createOrganization(user:User, name:string, timezone:string) {
  const tenant=randomUUID(), workspace=randomUUID();
  const slug=(name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,36)||"team")+"-"+tenant.slice(0,8);
  await transaction(tenant,user.id,async client=>{
    await client.query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",[tenant,slug,name]);
    await client.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[tenant,user.id]);
    await client.query("INSERT INTO workspaces(tenant_id,id,name,timezone) VALUES($1,$2,$3,$4)",[tenant,workspace,"Operations",timezone]);
    await client.query("INSERT INTO entitlements(tenant_id) VALUES($1)",[tenant]);
    await client.query("INSERT INTO tenant_routes(tenant_id) VALUES($1)",[tenant]);
    await audit(client,tenant,workspace,user.id,"workspace.created",workspace);
  });
  return {tenant,workspace};
}
export function workos() {
  const key=process.env.WORKOS_API_KEY, clientId=process.env.WORKOS_CLIENT_ID;
  return key && clientId ? {clientId, sdk:new WorkOS(key)} : undefined;
}

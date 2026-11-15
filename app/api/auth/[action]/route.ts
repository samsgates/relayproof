import { cookies } from "next/headers";
import { z } from "zod";
import { checkOrigin, currentUser, endSession, findScopes, HttpError, hash, origin, passwordHash, securityCookie,
  startSession, throttle, token, verifyPassword, workos, type User } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, input, missing, reply } from "@/lib/http";

export const runtime="nodejs";
type Params={params:Promise<{action:string}>};
const auth=z.object({email:z.email().max(254).transform(x=>x.toLowerCase()),password:z.string().min(12).max(200),name:z.string().trim().min(2).max(100).optional()});
export async function POST(request:Request,{params}:Params) {
  try {
    checkOrigin(request);
    const {action}=await params;
    if(action==="logout"){await endSession();return reply({ok:true});}
    if(action!=="login"&&action!=="register") return missing();
    const parsed=auth.parse(await input(request));
    await throttle("password:"+parsed.email,12,900);
    await throttle("password-global",240,60);
    let user:User|undefined;
    if(action==="register"){
      if(process.env.ALLOW_SIGNUP!=="true") throw new HttpError(403,"signup_closed","Registration is closed. Contact your administrator.");
      const pass=await passwordHash(parsed.password);
      user=(await pool().query<User>(`INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3)
        ON CONFLICT(email) DO NOTHING RETURNING id,email,name`,[parsed.email,parsed.name??parsed.email.split("@")[0],pass])).rows[0];
      if(!user) throw new HttpError(409,"account_exists","This email already has an account.");
    } else {
      const row=(await pool().query<User&{password_hash:string|null}>("SELECT id,email,name,password_hash FROM users WHERE email=$1",[parsed.email])).rows[0];
      if(!await verifyPassword(parsed.password,row?.password_hash)) throw new HttpError(401,"login_failed","The email or password is incorrect.");
      user=row;
    }
    await startSession(user.id);
    const scopes=await findScopes(user);
    return reply({next:scopes.length?"/w/"+scopes[0].workspace:"/setup"});
  } catch(error) {return fail(error);}
}
export async function GET(request:Request,{params}:Params){
  try{
    const {action}=await params;
    const identity=workos();
    if(!identity) return missing();
    const url=new URL(request.url);
    const jar=await cookies();
    const redirectUri=origin()+"/api/auth/callback";
    if(action==="workos"){
      const state=token();
      const next=url.searchParams.get("next");
      if(next?.startsWith("/invite?")&&next.length<500) jar.set("relay_auth_next",Buffer.from(next).toString("base64url"),{...securityCookie,maxAge:600});
      else jar.set("relay_auth_next","",{...securityCookie,maxAge:0});
      jar.set("relay_auth_state",hash(state),{...securityCookie,maxAge:600});
      return Response.redirect(identity.sdk.userManagement.getAuthorizationUrl({provider:"authkit",clientId:identity.clientId,redirectUri,state}));
    }
    if(action==="callback"){
      const state=url.searchParams.get("state"), code=url.searchParams.get("code"), expected=jar.get("relay_auth_state")?.value;
      jar.set("relay_auth_state","",{...securityCookie,maxAge:0});
      if(!state||!code||!expected||hash(state)!==expected) throw new HttpError(400,"oauth_state","The sign-in request expired. Try again.");
      const result=await identity.sdk.userManagement.authenticateWithCode({clientId:identity.clientId,code});
      if(!result.user.emailVerified) throw new HttpError(403,"email_unverified","Verify your email before signing in.");
      const email=result.user.email.toLowerCase();
      let user=(await pool().query<User>("SELECT id,email,name FROM users WHERE federated_subject=$1",[result.user.id])).rows[0];
      if(!user){
        const name=[result.user.firstName,result.user.lastName].filter(Boolean).join(" ")||email.split("@")[0];
        if(process.env.ALLOW_SIGNUP==="true"){
          user=(await pool().query<User>(`INSERT INTO users(email,name,federated_subject) VALUES($1,$2,$3)
            ON CONFLICT DO NOTHING RETURNING id,email,name`,[email,name,result.user.id])).rows[0];
        }
        if(!user) throw new HttpError(403,"identity_not_provisioned","Ask your administrator to provision this identity.");
      }
      await startSession(user.id);
      const scopes=await findScopes(user);
      const destination=Buffer.from(jar.get("relay_auth_next")?.value??"","base64url").toString("utf8");
      jar.set("relay_auth_next","",{...securityCookie,maxAge:0});
      if(destination.startsWith("/invite?")&&destination.length<500) return Response.redirect(origin()+destination);
      return Response.redirect(origin()+(scopes.length?"/w/"+scopes[0].workspace:"/setup"));
    }
    if(action==="session"){
      const user=await currentUser();
      return reply({user:user??null});
    }
    return missing();
  }catch(error){return fail(error);}
}

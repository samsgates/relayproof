import { currentUser, uuidPattern } from "@/lib/auth";
import AuthFrame from "../auth-frame";
import { AcceptInvite } from "../ui";

export const metadata={title:"Workspace invitation",referrer:"no-referrer"};
export default async function Invite({searchParams}:{searchParams:Promise<{tenant?:string;workspace?:string;token?:string}>}){
  const {tenant,workspace,token}=await searchParams;
  if(!tenant||!workspace||!token||!uuidPattern.test(tenant)||!uuidPattern.test(workspace)||!/^[-_a-zA-Z0-9]{43}$/.test(token))
    return <AuthFrame><h1>Invitation unavailable</h1><p>Ask your workspace administrator to issue a new invitation.</p></AuthFrame>;
  const returnTo="/invite?"+new URLSearchParams({tenant,workspace,token});
  return <AuthFrame><AcceptInvite tenant={tenant} workspace={workspace} inviteToken={token} loggedIn={Boolean(await currentUser())} returnTo={returnTo}/></AuthFrame>;
}

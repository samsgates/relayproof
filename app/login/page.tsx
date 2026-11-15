import { redirect } from "next/navigation";
import { currentUser, workos } from "@/lib/auth";
import AuthFrame from "../auth-frame";
import { LoginForm } from "../ui";

export const metadata={title:"Sign in"};
export default async function Login({searchParams}:{searchParams:Promise<{next?:string}>}){
  const value=(await searchParams).next;
  const next=value?.startsWith("/invite?")&&value.length<500?value:undefined;
  if(await currentUser())redirect(next??"/");
  return <AuthFrame><LoginForm signup={process.env.ALLOW_SIGNUP==="true"} sso={Boolean(workos())} next={next}/></AuthFrame>;
}

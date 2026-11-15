import { redirect } from "next/navigation";
import { currentUser, getScope } from "@/lib/auth";
import AuthFrame from "../auth-frame";
import { SetupForm } from "../ui";

export const metadata={title:"Create a workspace"};
export default async function Setup(){
  const user=await currentUser();
  if(!user)redirect("/login");
  const scope=await getScope(user);
  if(scope)redirect("/w/"+scope.workspace);
  return <AuthFrame><SetupForm/></AuthFrame>;
}

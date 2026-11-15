import { redirect } from "next/navigation";
import { currentUser, getScope } from "@/lib/auth";

export default async function Home() {
  const user=await currentUser();
  if(!user) redirect("/login");
  const scope=await getScope(user);
  redirect(scope?"/w/"+scope.workspace:"/setup");
}

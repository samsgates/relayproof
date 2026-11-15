import { z } from "zod";
import { HttpError } from "./auth";
import { ProviderError } from "./providers";

export async function input(request:Request):Promise<unknown> {
  if(!request.headers.get("content-type")?.startsWith("application/json")) throw new HttpError(415,"content_type","Send JSON for this request.");
  const size=Number(request.headers.get("content-length")??0);
  if(size>2_000_000) throw new HttpError(413,"payload_limit","This request exceeds 2 MB.");
  if(!request.body) throw new HttpError(400,"missing_payload","A request body is required.");
  const reader=request.body.getReader();
  const chunks:Buffer[]=[];
  let length=0;
  try {
    while(true) {
      const next=await reader.read();
      if(next.done) break;
      length+=next.value.byteLength;
      if(length>2_000_000) {await reader.cancel();throw new HttpError(413,"payload_limit","This request exceeds 2 MB.");}
      chunks.push(Buffer.from(next.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch(error) {
    if(error instanceof HttpError) throw error;
    throw new HttpError(400,"invalid_json","Enter valid JSON.");
  }
}
export function reply(result:unknown,status=200) {
  return Response.json(result,{status,headers:{"Cache-Control":"private, no-store"}});
}
export function fail(error:unknown) {
  if(error instanceof HttpError) return reply({error:error.code,message:error.message},error.status);
  if(error instanceof z.ZodError) return reply({error:"validation",message:error.issues.slice(0,6).map(i=>[i.path.join("."),i.message].filter(Boolean).join(" · ")).join(" | ")},422);
  if(error instanceof ProviderError) return reply({error:error.code,message:error.code.replaceAll("_"," ")},422);
  console.error(JSON.stringify({event:"request.error",type:error instanceof Error?error.name:"unknown"}));
  return reply({error:"internal",message:"RelayProof could not complete the request."},500);
}
export function missing():never {throw new HttpError(404,"not_found","That resource is unavailable.");}

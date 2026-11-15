import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key() {
  const raw=process.env.RELAY_ENCRYPTION_KEY ?? "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw) || Buffer.from(raw,"base64").length!==32)
    throw new Error("RELAY_ENCRYPTION_KEY must be a base64 encoded 32-byte key");
  return Buffer.from(raw,"base64");
}
export function seal(input:object, context:string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm",key(),nonce);
  cipher.setAAD(Buffer.from(context));
  const value = Buffer.concat([cipher.update(JSON.stringify(input),"utf8"),cipher.final()]);
  return ["v1",nonce.toString("base64url"),cipher.getAuthTag().toString("base64url"),value.toString("base64url")].join(".");
}
export function unseal<T>(serialized:string, context:string):T {
  const [version,nonce,tag,value] = serialized.split(".");
  if (version!=="v1" || !nonce || !tag || !value) throw new Error("Unsupported credential format");
  const decipher = createDecipheriv("aes-256-gcm",key(),Buffer.from(nonce,"base64url"));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag,"base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value,"base64url")),decipher.final()]).toString("utf8")) as T;
}

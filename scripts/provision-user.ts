import { pool } from "../lib/db";
import { passwordHash } from "../lib/auth";
import { z } from "zod";

const email=z.email().parse(process.argv[2]).toLowerCase();
const name=z.string().trim().min(2).max(100).parse(process.argv[3]);
const subject=process.argv[4];
try{
  if(subject){
    await pool().query("INSERT INTO users(email,name,federated_subject) VALUES($1,$2,$3)",[email,name,subject]);
  }else{
    let password="";
    for await(const chunk of process.stdin){
      password+=chunk;
      if(password.length>2048) throw new Error("Password input too long");
    }
    const encoded=await passwordHash(z.string().min(12).max(200).parse(password.replace(/\r?\n$/,"")));
    await pool().query("INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3)",[email,name,encoded]);
  }
  console.log("Account provisioned",email);
}finally{await pool().end();}

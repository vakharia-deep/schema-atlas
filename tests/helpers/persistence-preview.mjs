// Disposable PostgreSQL and saved-profile server for browser restart checks.
import { fixture } from './postgres.mjs';
import { ProfileStore, credentialEntry } from '../../lib/profiles.mjs';
import { createApp } from '../../server.mjs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
const f=await fixture(),directory=path.join(f.root,'profiles'),configFile=path.join(f.root,'browser-connection.json');
await writeFile(configFile,JSON.stringify(f.config),{mode:0o600});
let server,stopping=false;
async function start(){
  server=createApp({profileStore:new ProfileStore(directory)});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8789,'127.0.0.1',resolve);});
}
async function stopServer(){if(server)await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});}
async function stop(){
  if(stopping)return;stopping=true;await stopServer();
  try{await credentialEntry(directory).deleteCredential();}finally{await f.cleanup();}
  process.exit(0);
}
try{await start();}catch{await stop();throw new Error('Could not start the test server.');}
console.log('Disposable persistence fixture: '+configFile);
console.log('Browser: http://localhost:8789/ · Commands: restart, stop');
const input=createInterface({input:process.stdin});
input.on('line',async line=>{
  if(line==='restart'){await stopServer();await start();console.log('Server restarted; all active sessions cleared.');}
  if(line==='stop')await stop();
});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);

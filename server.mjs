import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PostgresProvider, AtlasError, validateConnection } from './lib/postgres.mjs';
import { QueryJob, validateQuery } from './lib/query.mjs';
import { ProfilingJob } from './lib/profiling.mjs';
import { ProfileStore, browserOwner } from './lib/profiles.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const routes=new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/profiling.js', ['profiling.js','text/javascript; charset=utf-8']],
  ['/plan.js', ['plan.js','text/javascript; charset=utf-8']],
  ['/profiling.css', ['profiling.css','text/css; charset=utf-8']],
  ['/query.js', ['query.js','text/javascript; charset=utf-8']],
  ['/query.css', ['query.css','text/css; charset=utf-8']],
  ['/app.js', ['app.js','text/javascript; charset=utf-8']],
  ['/polish.css', ['polish.css','text/css; charset=utf-8']],
  ['/style.css', ['style.css','text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg','image/svg+xml']],
]);
function headers(res){
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
}
function json(res,status,value){if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
function equal(a,b){return typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function cookieID(req,name='atlas_session'){const matches=(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));if(matches.length!==1)return null;const id=matches[0].slice(name.length+1);return /^[a-f0-9]{64}$/.test(id)?id:null;}
async function readJSON(req){
  if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))throw new AtlasError('INPUT','Use a JSON request body.',415);
  if(Number(req.headers['content-length']||0)>48000)throw new AtlasError('INPUT','Request body is too large.',413);
  const chunks=[];let bytes=0;
  for await(const chunk of req){bytes+=chunk.length;if(bytes>48000)throw new AtlasError('INPUT','Request body is too large.',413);chunks.push(chunk);}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new AtlasError('INPUT','Request body must be valid JSON.');}
}
function requireEmpty(req){if(req.headers['transfer-encoding']||Number(req.headers['content-length']||0)!==0)throw new AtlasError('INPUT','This endpoint does not accept a request body.',413);}

export function createApp({scanLimit=30,sessionTTL=30*60_000,providerFactory=(config,id)=>new PostgresProvider(config,id),queryFactory=(config,input)=>new QueryJob(config,input),queryLimit=30,profileStore=null,profilingFactory=config=>new ProfilingJob(config)}={}){
  const sessions=new Map();let requests=[],scans=[],queries=[],activeScans=0,activeQueries=0;
  async function removeSession(id){const s=sessions.get(id);if(!s)return;sessions.delete(id);for(const job of s.jobs.values())job.runner.stop();await Promise.allSettled([...s.connections.values()].map(p=>p.close()));s.connections.clear();s.captures.clear();}
  function expire(){const now=Date.now();for(const[id,s]of sessions)if(now-s.touched>sessionTTL||now-s.created>8*60*60_000)void removeSession(id);}
  const interval=setInterval(expire,60_000);interval.unref();
  function connectionInfo(p){return {...p.publicInfo(),...(p.profileId?{profileId:p.profileId}:{})};}
  function inventory(s){return [...s.connections.values()].map(connectionInfo);}
  async function savedInventory(s){
    if(!profileStore)return {savedConnections:[],selectedProfileId:null,storage:{available:false,message:'Saved connections are not configured.'}};
    try{return {...await profileStore.list(s.owner),storage:{available:true}};}
    catch{return {savedConnections:[],selectedProfileId:null,storage:{available:false,message:'Saved connections are unavailable. Unlock your operating system credential store and reload.'}};}
  }
  function connectionBudget(session,now,res){
    session.attempts=session.attempts.filter(t=>now-t<60_000);
    if(session.attempts.length>=10){res.setHeader('Retry-After','60');throw new AtlasError('BUSY','Please wait before connecting again.',429);}session.attempts.push(now);
    if(session.connecting)throw new AtlasError('BUSY','A connection attempt is already running.',429);
  }
  function liveSession(sid,session,res){if(sessions.get(sid)!==session||res.destroyed)throw new AtlasError('SESSION','The connection session ended. Reload and select your saved connection.',401);}

  async function scan(provider){if(activeScans>=2)throw new AtlasError('BUSY','Another catalog scan is running. Please try again shortly.',429);activeScans++;try{return await provider.inspect();}finally{activeScans--;}}
  const server=http.createServer(async(req,res)=>{
    headers(res);
    const port=server.address()?.port,hosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
    if(!hosts.has(req.headers.host))return json(res,403,{error:'Host is not allowed.'});
    const origin=`http://${req.headers.host}`;
    if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{error:'Cross-origin request rejected.'});
    if(req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'Cross-site request rejected.'});
    const now=Date.now();requests=requests.filter(t=>now-t<60_000);
    if(requests.length>=300){res.setHeader('Retry-After','60');return json(res,429,{error:'Too many requests.'});}requests.push(now);
    let url;try{url=new URL(req.url,origin);}catch{return json(res,400,{error:'Invalid request.'});}
    if(url.search||url.pathname.length>200)return json(res,400,{error:'Unexpected request parameters.'});
    try{
      if(req.method==='GET'&&routes.has(url.pathname)){
        const[file,type]=routes.get(url.pathname),body=await readFile(path.join(root,'web',file));res.writeHead(200,{'Content-Type':type});return res.end(body);
      }
      expire();let sid=cookieID(req),session=sessions.get(sid);
      let browserToken=profileStore?cookieID(req,'atlas_browser'):null;
      if(session&&profileStore&&(!browserToken||browserOwner(browserToken)!==session.owner))session=null;
      if(req.method==='GET'&&url.pathname==='/api/session'){
        if(!session){
          if(sessions.size>=20)throw new AtlasError('BUSY','Too many browser sessions. Try again later.',429);
          if(profileStore&&!browserToken)browserToken=randomBytes(32).toString('hex');
          sid=randomBytes(32).toString('hex');session={owner:browserToken?browserOwner(browserToken):null,csrf:randomBytes(32).toString('hex'),created:now,touched:now,connections:new Map(),attempts:[],queryAttempts:[],jobs:new Map(),captures:new Map(),connecting:false};sessions.set(sid,session);
          // HTTP is loopback-only; the cross-machine transport is an authenticated SSH tunnel.
          res.setHeader('Set-Cookie',`atlas_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        }
        if(profileStore){const cookies=res.getHeader('Set-Cookie');res.setHeader('Set-Cookie',[...(cookies?[cookies]:[]),'atlas_browser='+browserToken+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000']);}
        session.touched=now;
        return json(res,200,{csrf:session.csrf,connections:inventory(session),...await savedInventory(session),capabilities:{query:true,queryMode:'read-only',postgres:true,refresh:true}});
      }
      if(req.method!=='POST')return json(res,404,{error:'Endpoint not found.'});
      if(!session)return json(res,401,{error:'Your connection session expired. Reload the page and reconnect.'});
      if(!equal(req.headers['x-atlas-csrf'],session.csrf))return json(res,403,{error:'Reload the page to renew the session.'});
      session.touched=now;
      if(url.pathname==='/api/connections'){
        connectionBudget(session,now,res);
        if(session.connections.size>=4)throw new AtlasError('LIMIT','Disconnect a database before adding another (maximum four).',409);
        session.connecting=true;let provider;
        try{
          const input=await readJSON(req);
          if(!input||typeof input!=='object'||Array.isArray(input)||input.save!==undefined&&typeof input.save!=='boolean')throw new AtlasError('INPUT','Check the connection fields.');
          const {save=false,...fields}=input,config=validateConnection(fields);
          if(save&&!profileStore)throw new AtlasError('PROFILE_STORE','Saved connections are not configured.',503);
          const id='pg-'+randomBytes(12).toString('hex');provider=providerFactory(config,id);
          const model=await scan(provider);
          if(sessions.get(sid)!==session||req.destroyed&&res.destroyed)throw new AtlasError('SESSION','The connection session ended. Reload and try again.',401);
          if(save){provider.profileId=(await profileStore.save(session.owner,config)).id;for(const active of session.connections.values())if(active.profileId===provider.profileId)delete active.profileId;}
          liveSession(sid,session,res);session.connections.set(id,provider);
          return json(res,201,{connection:connectionInfo(provider),model,connections:inventory(session),...await savedInventory(session)});
        }catch(error){if(provider)await provider.close();throw error;}finally{session.connecting=false;}
      }
      const savedRoute=url.pathname.match(/^\/api\/profiles\/(saved-[a-f0-9]{24})\/(connect|forget)$/);
      if(savedRoute){
        requireEmpty(req);if(!profileStore)throw new AtlasError('NOT_FOUND','Saved connection not found in this browser.',404);
        connectionBudget(session,now,res);session.connecting=true;
        const [,profileId,action]=savedRoute;let provider,replaced,created=false;
        try{
          if(action==='forget'){
            await profileStore.remove(session.owner,profileId);
            for(const ownerSession of sessions.values())if(ownerSession.owner===session.owner)for(const active of ownerSession.connections.values())if(active.profileId===profileId)delete active.profileId;
            return json(res,200,{connections:inventory(session),...await savedInventory(session)});
          }
          // The persistent browser identity scopes the lookup before credentials leave storage.
          const config=await profileStore.get(session.owner,profileId);
          provider=[...session.connections.values()].find(p=>p.profileId===profileId);
          if(provider&&Object.keys(config).some(k=>config[k]!==provider.config[k])){if([...session.jobs.values()].some(job=>job.connectionID===provider.id))throw new AtlasError('BUSY','Wait for the active query before reconnecting.',409);replaced=provider;provider=null;}
          if(!provider){
            if(!replaced&&session.connections.size>=4)throw new AtlasError('LIMIT','Disconnect a database before adding another (maximum four).',409);
            provider=providerFactory(config,'pg-'+randomBytes(12).toString('hex'));provider.profileId=profileId;created=true;
          }
          const model=await scan(provider);liveSession(sid,session,res);
          await profileStore.select(session.owner,profileId);liveSession(sid,session,res);
          if(replaced){session.captures.delete(replaced.id);session.connections.delete(replaced.id);await replaced.close();}
          if(created)session.connections.set(provider.id,provider);
          return json(res,200,{connection:connectionInfo(provider),connections:inventory(session),model,...await savedInventory(session)});
        }catch(error){if(created&&provider)await provider.close();throw error;}finally{session.connecting=false;}
      }
      const saveLive=url.pathname.match(/^\/api\/connections\/(pg-[a-f0-9]{24})\/save$/);
      if(saveLive){
        requireEmpty(req);const provider=session.connections.get(saveLive[1]);
        if(!provider)throw new AtlasError('NOT_FOUND','Connection not found in this browser session.',404);
        if(!profileStore)throw new AtlasError('PROFILE_STORE','Saved connections are not configured.',503);
        connectionBudget(session,now,res);session.connecting=true;
        try{provider.profileId=(await profileStore.save(session.owner,provider.config)).id;return json(res,200,{connections:inventory(session),...await savedInventory(session)});}
        finally{session.connecting=false;}
      }
      const profilingRoute=url.pathname.match(/^\/api\/connections\/(pg-[a-f0-9]{24})\/profiling\/([a-f0-9]{32})\/(diagnostics|start|stop|discard|explain)$/);
      if(profilingRoute){
        const [,connectionID,operationID,action]=profilingRoute,provider=session.connections.get(connectionID);
        if(!provider)throw new AtlasError('NOT_FOUND','Connection not found in this browser session.',404);
        queries=queries.filter(t=>now-t<60_000);session.queryAttempts=session.queryAttempts.filter(t=>now-t<60_000);
        if(queries.length>=60||session.queryAttempts.length>=queryLimit){res.setHeader('Retry-After','60');throw new AtlasError('BUSY','Please wait before running more profiling requests.',429);}
        if(activeQueries>=2||session.jobs.size)throw new AtlasError('BUSY','A query or profiling operation is already running.',429);
        queries.push(now);session.queryAttempts.push(now);activeQueries++;
        const runner=profilingFactory(provider.config),slot={connectionID,runner};session.jobs.set(operationID,slot);
        const abort=()=>{if(!res.writableEnded)runner.stop();};res.once('close',abort);
        try{
          const input=action==='explain'?await readJSON(req):(requireEmpty(req),null);
          let result;
          if(action==='explain')result=await runner.explain(input);
          else if(action==='diagnostics'){const {internal,...visible}=await runner.diagnostics();result={...visible,activeCapture:session.captures.has(connectionID)?{startedAt:session.captures.get(connectionID).startedAt}:null};}
          else if(action==='discard'){session.captures.delete(connectionID);result={discarded:true};}
          else if(action==='start'){
            const previous=session.captures.get(connectionID);
            if(previous&&now-Date.parse(previous.startedAt)<30*60_000)throw new AtlasError('BUSY','A capture is already active for this connection.',409);
            const capture=await runner.start();liveSession(sid,session,res);
            if(!session.connections.has(connectionID))throw new AtlasError('NOT_FOUND','Connection was disconnected.',404);
            session.captures.set(connectionID,capture);result={startedAt:capture.startedAt};
          }else{
            const capture=session.captures.get(connectionID);
            if(!capture)throw new AtlasError('NOT_FOUND','No capture is active for this connection.',404);
            result=await runner.finish(capture);session.captures.delete(connectionID);
          }
          liveSession(sid,session,res);return json(res,200,result);
        }finally{res.removeListener('close',abort);session.jobs.delete(operationID);activeQueries--;}
      }
      const queryRoute=url.pathname.match(/^\/api\/connections\/(pg-[a-f0-9]{24})\/queries\/([a-f0-9]{32})\/(run|cancel)$/);
      if(queryRoute){
        const [,connectionID,queryID,action]=queryRoute,provider=session.connections.get(connectionID);
        if(!provider)throw new AtlasError('NOT_FOUND','Connection not found in this browser session.',404);
        if(action==='cancel'){
          requireEmpty(req);const job=session.jobs.get(queryID);
          if(!job||job.connectionID!==connectionID)throw new AtlasError('NOT_FOUND','Active query not found.',404);
          return json(res,200,{cancelled:job.runner.stop()});
        }
        queries=queries.filter(t=>now-t<60_000);session.queryAttempts=session.queryAttempts.filter(t=>now-t<60_000);
        if(queries.length>=60||session.queryAttempts.length>=queryLimit){res.setHeader('Retry-After','60');throw new AtlasError('BUSY','Please wait before running more queries.',429);}
        if(activeQueries>=2||session.jobs.size)throw new AtlasError('BUSY','A query is already running. Wait or cancel it first.',429);
        queries.push(now);session.queryAttempts.push(now);activeQueries++;
        const slot={connectionID,runner:{stop:()=>false}};session.jobs.set(queryID,slot);
        const abort=()=>{if(!res.writableEnded)slot.runner.stop();};res.once('close',abort);
        try{
          const input=validateQuery(await readJSON(req));
          if(sessions.get(sid)!==session||!session.connections.has(connectionID)||res.destroyed)throw new AtlasError('SESSION','The connection session ended. Reconnect and try again.',401);
          slot.runner=queryFactory(provider.config,input);
          return json(res,200,await slot.runner.run());
        }finally{res.removeListener('close',abort);session.jobs.delete(queryID);activeQueries--;}
      }
      const match=url.pathname.match(/^\/api\/connections\/(pg-[a-f0-9]{24})\/(refresh|disconnect)$/);
      if(match){
        requireEmpty(req);const provider=session.connections.get(match[1]);
        if(!provider)throw new AtlasError('NOT_FOUND','Connection not found in this browser session.',404);
        if(match[2]==='disconnect'){
          let warning;
          if(profileStore&&provider.profileId){try{if((await profileStore.list(session.owner)).selectedProfileId===provider.profileId)await profileStore.select(session.owner,null);}catch{warning='Disconnected. Saved storage is unavailable, so its previous auto-reconnect selection could not be cleared.';}}
          for(const job of session.jobs.values())if(job.connectionID===match[1])job.runner.stop();
          session.captures.delete(match[1]);session.connections.delete(match[1]);await provider.close();return json(res,200,{connections:inventory(session),...await savedInventory(session),...(warning?{warning}:{})});
        }
        scans=scans.filter(t=>now-t<60_000);if(scans.length>=scanLimit){res.setHeader('Retry-After','60');throw new AtlasError('BUSY','Please wait before refreshing again.',429);}scans.push(now);
        return json(res,200,await scan(provider));
      }
      return json(res,404,{error:'Endpoint not found.'});
    }catch(error){
      if(error instanceof AtlasError)return json(res,error.status,{error:error.message,code:error.code,...(error.sqlState?{sqlState:error.sqlState}:{}),...(error.position?{position:error.position}:{})});
      console.error('Schema Atlas request failed:',error.name||'request_error');
      return json(res,500,{error:'Could not complete the request. Your previous diagram is retained.'});
    }
  });
  server.on('close',()=>{clearInterval(interval);for(const id of sessions.keys())void removeSession(id);});
  server.requestTimeout=30_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;server.maxConnections=40;
  return server;
}
async function main(){
  const argv=process.argv.slice(2);let port=8787;
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--port'&&/^\d{4,5}$/.test(argv[i+1]||''))port=Number(argv[++i]);
    else if(argv[i]==='--help'){console.log('Usage: node server.mjs [--port 8787]\nConnect PostgreSQL from the browser.');return;}
    else throw new Error('Unknown or incomplete argument. Use --help.');
  }
  if(port<1024||port>65535)throw new Error('Invalid port.');
  const server=createApp({profileStore:new ProfileStore()});
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Port is in use. Choose another with --port.':'Server could not start.');process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`Schema Atlas → http://127.0.0.1:${port}\nConnect to PostgreSQL in the browser · Read-only catalog inspection`));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.closeAllConnections();server.close();});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Startup failed. Check arguments and dependencies; use --help.');process.exitCode=1;});

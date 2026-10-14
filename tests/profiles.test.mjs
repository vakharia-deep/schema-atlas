import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, chmod, stat, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProfileStore, browserOwner, credentialEntry } from '../lib/profiles.mjs';
import { AtlasError } from '../lib/postgres.mjs';
import { createApp } from '../server.mjs';

const details=()=>({name:'Private profile',host:'localhost',port:5432,database:'private_db',user:'reader',password:randomBytes(32).toString('base64url'),tls:'local',ca:''});
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'atlas-profiles-'));await chmod(directory,0o700);
  const key=randomBytes(32),owner=browserOwner(randomBytes(32).toString('hex')),keyProvider=async()=>key;
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,keyProvider,owner,store:new ProfileStore(directory,{keyProvider})};
}
test('saved profiles are authenticated ciphertext with private permissions and survive store reconstruction',async t=>{
  const f=await fixture(t),input=details(),saved=await f.store.save(f.owner,input),file=path.join(f.directory,f.owner+'.vault');
  const bytes=await readFile(file);
  for(const value of [input.password,input.database,input.user,input.name])assert.equal(bytes.includes(Buffer.from(value)),false);
  assert.equal((await stat(file)).mode&0o777,0o600);
  const restarted=new ProfileStore(f.directory,{keyProvider:f.keyProvider});
  assert.deepEqual(await restarted.get(f.owner,saved.id),input);
  const listing=await restarted.list(f.owner);assert.equal(listing.selectedProfileId,saved.id);assert.equal(listing.savedConnections.length,1);
  assert.equal(JSON.stringify(listing).includes(input.password),false);assert.equal(Object.hasOwn(listing.savedConnections[0],'password'),false);
  const updated=await restarted.save(f.owner,{...input,password:randomBytes(20).toString('hex'),name:'Updated profile'});
  assert.equal(updated.id,saved.id);assert.equal((await restarted.list(f.owner)).savedConnections.length,1);
  assert.equal((await restarted.get(f.owner,saved.id)).name,'Updated profile');
  await restarted.select(f.owner,null);assert.equal((await restarted.list(f.owner)).selectedProfileId,null);
  assert.equal((await restarted.list(f.owner)).savedConnections.length,1);
  await restarted.remove(f.owner,saved.id);assert.deepEqual((await restarted.list(f.owner)).savedConnections,[]);
});
test('storage rejects other owners, modified or swapped ciphertext, symlinks, and missing keys without overwriting',async t=>{
  const f=await fixture(t),saved=await f.store.save(f.owner,details()),other=browserOwner(randomBytes(32).toString('hex'));
  assert.deepEqual((await f.store.list(other)).savedConnections,[]);
  await assert.rejects(f.store.get(other,saved.id),{code:'NOT_FOUND'});
  await assert.rejects(f.store.remove(other,saved.id),{code:'NOT_FOUND'});
  await assert.rejects(f.store.list('../escape'),{code:'NOT_FOUND'});
  const file=path.join(f.directory,f.owner+'.vault'),original=await readFile(file),changed=Buffer.from(original);changed[changed.length-1]^=1;await writeFile(file,changed);
  await assert.rejects(f.store.get(f.owner,saved.id),{code:'PROFILE_STORE'});assert.deepEqual(await readFile(file),changed);
  await writeFile(file,original);
  await copyFile(file,path.join(f.directory,other+'.vault'));await chmod(path.join(f.directory,other+'.vault'),0o600);
  await assert.rejects(f.store.list(other),{code:'PROFILE_STORE'});
  const locked=new ProfileStore(f.directory,{keyProvider:async()=>{throw new AtlasError('PROFILE_STORE','Credential store locked.',503);}});
  await assert.rejects(locked.save(f.owner,details()),{code:'PROFILE_STORE'});assert.deepEqual(await readFile(file),original);
  await rm(file);await symlink(path.join(f.directory,other+'.vault'),file);
  await assert.rejects(f.store.list(f.owner),{code:'PROFILE_STORE'});
});
test('concurrent profile saves retain every distinct profile and enforce profile bounds',async t=>{
  const f=await fixture(t);
  await Promise.all(Array.from({length:20},(_,i)=>f.store.save(f.owner,{...details(),database:'db_'+i})));
  assert.equal((await f.store.list(f.owner)).savedConnections.length,20);
  await assert.rejects(f.store.save(f.owner,{...details(),database:'overflow'}),{code:'LIMIT'});
  assert.equal((await f.store.list(f.owner)).savedConnections.length,20);
});
async function start(f){
  const instances=[];
  const server=createApp({profileStore:new ProfileStore(f.directory,{keyProvider:f.keyProvider}),providerFactory:(config,id)=>{
    const provider={id,config,publicInfo:()=>({id,name:config.name,host:config.host,port:config.port,database:config.database,user:config.user,tls:config.tls,provider:'postgres'}),
      inspect:async()=>({repository:{id,name:config.name},tables:[],capabilities:{provider:'postgres'}}),
      close:async()=>{config.password='';provider.closed=true;}};
    instances.push(provider);return provider;
  }});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {instances,url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>{server.closeAllConnections();server.close(r);})};
}
test('disconnect closes active credentials even when saved storage becomes unavailable',async t=>{
  const f=await fixture(t);let locked=false;
  const app=await start({...f,keyProvider:async()=>{if(locked)throw new AtlasError('PROFILE_STORE','Unavailable.',503);return f.keyProvider();}});
  t.after(()=>app.close());const one=browser();await one.boot(app.url);
  const live=await(await one.post(app.url,'/api/connections',{...details(),save:true})).json();locked=true;
  const response=await one.post(app.url,'/api/connections/'+live.connection.id+'/disconnect');assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.connections.length,0);assert.equal(data.storage.available,false);assert.ok(data.warning);
  assert.equal(app.instances[0].closed,true);assert.equal(app.instances[0].config.password,'');
});
function browser(){
  const jar=new Map();let session;
  const cookie=()=>[...jar].map(([k,v])=>k+'='+v).join('; ');
  return {cookie,
    async boot(url){
      const response=await fetch(url+'/api/session',{headers:{Cookie:cookie()}});
      for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1));}
      session=await response.json();return {response,session};
    },
    post:(url,route,body)=>fetch(url+route,{method:'POST',headers:{Cookie:cookie(),'X-Atlas-CSRF':session.csrf,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})})
  };
}
test('HTTP restart restores saved dropdown profiles and reconnects without the database password; other browsers stay isolated',async t=>{
  const f=await fixture(t),one=browser(),two=browser();let app=await start(f);t.after(()=>app.close());
  const {response}=await one.boot(app.url);assert.ok(response.headers.getSetCookie().some(c=>c.startsWith('atlas_browser=')&&c.includes('HttpOnly')&&c.includes('SameSite=Strict')&&c.includes('Max-Age=31536000')));
  await two.boot(app.url);
  const input=details(),created=await one.post(app.url,'/api/connections',{...input,save:true});assert.equal(created.status,201);
  const data=await created.json(),id=data.connection.profileId;assert.match(id,/^saved-/);assert.ok(!JSON.stringify(data).includes(input.password));
  assert.equal((await two.boot(app.url)).session.savedConnections.length,0);
  for(const action of ['connect','forget'])assert.equal((await two.post(app.url,'/api/profiles/'+id+'/'+action)).status,404);
  assert.equal((await fetch(app.url+'/api/profiles/'+id+'/connect',{method:'POST',headers:{Cookie:one.cookie()}})).status,403);
  assert.equal((await one.post(app.url,'/api/profiles/'+id+'/connect',{password:'unexpected'})).status,413);
  await app.close();app=await start(f);
  const recovered=(await one.boot(app.url)).session;
  assert.equal(recovered.connections.length,0);assert.equal(recovered.savedConnections[0].id,id);assert.equal(recovered.selectedProfileId,id);
  const result=await one.post(app.url,'/api/profiles/'+id+'/connect');assert.equal(result.status,200);const live=await result.json();
  assert.equal(app.instances[0].config.password,input.password);assert.equal(JSON.stringify(live).includes(input.password),false);
  const disconnected=await one.post(app.url,'/api/connections/'+live.connection.id+'/disconnect');assert.equal(disconnected.status,200);
  const kept=await disconnected.json();assert.equal(kept.savedConnections.length,1);assert.equal(kept.selectedProfileId,null);assert.equal(kept.connections.length,0);
  assert.equal((await one.post(app.url,'/api/profiles/'+id+'/connect')).status,200);
  const forgotten=await one.post(app.url,'/api/profiles/'+id+'/forget');assert.equal(forgotten.status,200);assert.equal((await forgotten.json()).savedConnections.length,0);
  assert.equal((await one.post(app.url,'/api/profiles/'+id+'/connect')).status,404);
});
test('temporary connections can be saved explicitly; storage failures do not silently pretend credentials were saved',async t=>{
  const f=await fixture(t),app=await start(f),one=browser(),two=browser();t.after(()=>app.close());
  await one.boot(app.url);await two.boot(app.url);
  const live=await(await one.post(app.url,'/api/connections',details())).json();assert.equal(live.savedConnections.length,0);
  assert.equal((await two.post(app.url,'/api/connections/'+live.connection.id+'/save')).status,404);
  const saved=await one.post(app.url,'/api/connections/'+live.connection.id+'/save');assert.equal(saved.status,200);assert.equal((await saved.json()).savedConnections.length,1);
  const locked=createApp({profileStore:new ProfileStore(f.directory,{keyProvider:async()=>{throw new AtlasError('PROFILE_STORE','Unavailable.',503);}})});
  await new Promise(r=>locked.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{locked.closeAllConnections();locked.close(r);}));
  const lockedSession=(await one.boot('http://127.0.0.1:'+locked.address().port)).session;
  assert.equal(lockedSession.storage.available,false);
});
test('native credential store preserves the encryption key across independent store instances',{skip:process.env.ATLAS_TEST_KEYCHAIN!=='1'},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'atlas-keychain-test-'));await chmod(directory,0o700);
  t.after(async()=>{await credentialEntry(directory).deleteCredential();await rm(directory,{recursive:true,force:true});});
  const owner=browserOwner(randomBytes(32).toString('hex')),config=details(),store=new ProfileStore(directory);
  const saved=await store.save(owner,config);
  assert.deepEqual(await new ProfileStore(directory).get(owner,saved.id),config);
});

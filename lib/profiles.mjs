import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, lstat, open, rename, unlink, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { AsyncEntry } from '@napi-rs/keyring';
import { AtlasError, validateConnection } from './postgres.mjs';

const UNCHANGED=Symbol('unchanged');
const MAX_BYTES=1024*1024,MAX_PROFILES=20,MAGIC=Buffer.from('ATLAS01\n');
const unavailable=()=>new AtlasError('PROFILE_STORE','Saved connections are unavailable. Unlock your operating system credential store and try again. No credentials were saved.',503);
const invalid=()=>new AtlasError('PROFILE_STORE','The saved connection file could not be verified. It has not been changed.',503);
const missing=()=>new AtlasError('NOT_FOUND','Saved connection not found in this browser.',404);
export const profileID=id=>typeof id==='string'&&/^saved-[a-f0-9]{24}$/.test(id);
export const browserOwner=token=>createHash('sha256').update(token).digest('hex');
export function defaultProfileDirectory(){
  return process.platform==='darwin'?path.join(homedir(),'Library','Application Support','Schema Atlas'):path.join(homedir(),'.schema-atlas');
}
export function credentialEntry(directory){
  // Pin Linux to persistent Secret Service; a volatile kernel-keyring fallback
  // would silently lose the encryption key on logout/reboot.
  return new AsyncEntry('Schema Atlas', 'profile-key-v1-'+createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0,32),
    process.platform==='linux'?{linux:{store:'secret-service'}}:undefined);
}
export function osKeyProvider(directory){
  let pending;
  return async create=>{
    if(!pending)pending=(async()=>{
      const entry=credentialEntry(directory);
      let encoded=await entry.getPassword(AbortSignal.timeout(8000));
      if(encoded===null){
        if(!create)throw unavailable();
        encoded=randomBytes(32).toString('base64');
        await entry.setPassword(encoded,AbortSignal.timeout(8000));
      }
      if(!/^[A-Za-z0-9+/]{43}=$/.test(encoded))throw unavailable();
      const key=Buffer.from(encoded,'base64');if(key.length!==32)throw unavailable();return key;
    })().catch(()=>{pending=null;throw unavailable();});
    return pending;
  };
}
const publicProfile=p=>({id:p.id,name:p.config.name,host:p.config.host,port:p.config.port,database:p.config.database,user:p.config.user,tls:p.config.tls,provider:'postgres',saved:true});

export class ProfileStore {
  constructor(directory=defaultProfileDirectory(),{keyProvider=osKeyProvider(directory)}={}){
    this.directory=path.resolve(directory);this.keyProvider=keyProvider;this.queue=Promise.resolve();
  }
  async folder(){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const stat=await lstat(this.directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077)))throw unavailable();
  }
  filename(owner){
    if(typeof owner!=='string'||!/^[a-f0-9]{64}$/.test(owner))throw missing();
    return path.join(this.directory,owner+'.vault');
  }
  validate(data){
    if(!data||data.version!==1||!Array.isArray(data.profiles)||data.profiles.length>MAX_PROFILES)throw invalid();
    const ids=new Set(),profiles=data.profiles.map(p=>{
      if(!p||!profileID(p.id)||ids.has(p.id))throw invalid();ids.add(p.id);
      return {id:p.id,config:validateConnection(p.config)};
    });
    if(data.selected!==null&&!ids.has(data.selected))throw invalid();
    return {version:1,profiles,selected:data.selected};
  }
  async read(owner){
    const filename=this.filename(owner);await this.folder();let file;
    try{file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);}
    catch(error){if(error.code==='ENOENT')return {version:1,profiles:[],selected:null};throw invalid();}
    let payload;
    try{
      const stat=await file.stat();
      if(!stat.isFile()||stat.size>MAX_BYTES||stat.size<MAGIC.length+29||process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077)))throw invalid();
      const buffer=Buffer.alloc(MAX_BYTES+1),{bytesRead}=await file.read(buffer,0,buffer.length,0);
      if(bytesRead>MAX_BYTES)throw invalid();payload=buffer.subarray(0,bytesRead);
    }finally{await file.close();}
    const key=await this.keyProvider(false);
    try{
      if(!payload.subarray(0,MAGIC.length).equals(MAGIC))throw invalid();
      const cipher=createDecipheriv('aes-256-gcm',key,payload.subarray(8,20),{authTagLength:16});
      cipher.setAAD(Buffer.from('schema-atlas:profiles:v1:'+owner));cipher.setAuthTag(payload.subarray(20,36));
      const plaintext=Buffer.concat([cipher.update(payload.subarray(36)),cipher.final()]);
      try{return this.validate(JSON.parse(plaintext.toString('utf8')));}finally{plaintext.fill(0);}
    }catch{throw invalid();}
  }
  async write(owner,data){
    const filename=this.filename(owner);await this.folder();data=this.validate(data);
    const entries=await readdir(this.directory);
    if(!entries.includes(path.basename(filename))&&entries.filter(x=>x.endsWith('.vault')).length>=128)throw new AtlasError('LIMIT','Saved connection storage is full.',409);
    const key=await this.keyProvider(!entries.some(x=>x.endsWith('.vault'))),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce,{authTagLength:16});
    cipher.setAAD(Buffer.from('schema-atlas:profiles:v1:'+owner));
    const plaintext=Buffer.from(JSON.stringify(data));let payload;
    try{const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);payload=Buffer.concat([MAGIC,nonce,cipher.getAuthTag(),encrypted]);}
    finally{plaintext.fill(0);}
    if(payload.length>MAX_BYTES)throw new AtlasError('LIMIT','Saved connection storage is full.',409);
    const temporary=path.join(this.directory,'.'+randomBytes(16).toString('hex')+'.tmp');let file;
    try{file=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await file.writeFile(payload);await file.sync();await file.close();file=null;await rename(temporary,filename);}
    finally{await file?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  async modify(owner,fn){
    const task=this.queue.then(async()=>{const data=await this.read(owner),result=fn(data);if(result!==UNCHANGED)await this.write(owner,data);return result===UNCHANGED?undefined:result;});
    this.queue=task.catch(()=>{});return task;
  }
  async list(owner){
    await this.queue;const data=await this.read(owner);
    return {savedConnections:data.profiles.map(publicProfile),selectedProfileId:data.selected};
  }
  async get(owner,id){
    if(!profileID(id))throw missing();await this.queue;
    const p=(await this.read(owner)).profiles.find(p=>p.id===id);if(!p)throw missing();return p.config;
  }
  async save(owner,input){
    const config=validateConnection(input);
    return this.modify(owner,data=>{
      let p=data.profiles.find(p=>['host','port','database','user'].every(k=>p.config[k]===config[k]));
      if(!p){if(data.profiles.length>=MAX_PROFILES)throw new AtlasError('LIMIT','You can save up to 20 connections. Remove an unused profile first.',409);p={id:'saved-'+randomBytes(12).toString('hex'),config};data.profiles.push(p);}
      else p.config=config;
      data.selected=p.id;return publicProfile(p);
    });
  }
  async select(owner,id){
    return this.modify(owner,data=>{if(id!==null&&!data.profiles.some(p=>p.id===id))throw missing();if(data.selected===id)return UNCHANGED;data.selected=id;});
  }
  async remove(owner,id){
    return this.modify(owner,data=>{const index=data.profiles.findIndex(p=>p.id===id);if(index<0)throw missing();data.profiles.splice(index,1);if(data.selected===id)data.selected=null;});
  }
}

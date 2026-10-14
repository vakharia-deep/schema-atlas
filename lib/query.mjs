import pg from 'pg';
import { AtlasError, clientOptions } from './postgres.mjs';

export const QUERY_LIMITS = Object.freeze({sqlBytes:32000, rows:1000, resultBytes:2*1024*1024, wireBytes:8*1024*1024, milliseconds:20000, columns:200});
export function validateQuery(input) {
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['sql','limit','timeout'].includes(k)))
    throw new AtlasError('INPUT','Provide SQL, a row limit and a timeout.');
  const {sql,limit=500,timeout=15000}=input;
  if(typeof sql!=='string'||!sql.trim()||Buffer.byteLength(sql)>QUERY_LIMITS.sqlBytes||sql.includes('\0'))
    throw new AtlasError('INPUT','Enter a query of at most 32 KB.');
  if(!Number.isInteger(limit)||limit<1||limit>QUERY_LIMITS.rows||!Number.isInteger(timeout)||timeout<100||timeout>QUERY_LIMITS.milliseconds)
    throw new AtlasError('INPUT','Use a row limit from 1 to 1,000 and a timeout from 100 to 20,000 milliseconds.');
  // This is a command gate, not a SQL parser. PostgreSQL enforces one statement
  // through the extended protocol, and enforces writes through READ ONLY.
  let start=sql.trimStart();
  while(start.startsWith('--')||start.startsWith('/*')){
    if(start.startsWith('--')){const end=start.indexOf('\n');start=end<0?'':start.slice(end+1).trimStart();}
    else {let depth=1,i=2;for(;i<start.length&&depth;i++){if(start.slice(i,i+2)==='/*'){depth++;i++;}else if(start.slice(i,i+2)==='*/'){depth--;i++;}}start=depth?'':start.slice(i).trimStart();}
  }
  if(!/^(SELECT|WITH|EXPLAIN|SHOW|TABLE|VALUES)\b/i.test(start))
    throw new AtlasError('READ_ONLY','Use a single SELECT, WITH, EXPLAIN, SHOW, TABLE or VALUES statement. This workspace is read-only.',422);
  return {sql,limit,timeout};
}

function queryError(error) {
  if(error instanceof AtlasError)return error;
  const codes={
    '25006':['READ_ONLY','This statement attempts to modify the database. Queries run in a read-only transaction.'],
    '42501':['PERMISSION','The connected database role does not have permission for this query.'],
    '42601':['SYNTAX','SQL syntax error. Check the statement near the indicated position. Run one statement at a time.'],
    '42P01':['RELATION','Table or view not found. Check the schema-qualified name.'],
    '42703':['COLUMN','Column not found. Check the column names and aliases.'],
    '42883':['FUNCTION','Function or operator not found. Check argument types and casts.'],
    '57014':['TIMEOUT','The query exceeded its timeout or was cancelled by PostgreSQL.'],
    '55P03':['LOCK_TIMEOUT','The query could not acquire a lock within the time limit.'],
    '22012':['DATA','Division by zero. Check the query expressions.']
  };
  const [code,message]=codes[error.code]||['QUERY','PostgreSQL could not execute this query. Check its syntax, types and permissions.'];
  const result=new AtlasError(code,message,422);
  // Raw database messages/details can contain values, SQL or function internals.
  if(/^[A-Z0-9]{5}$/.test(error.code||''))result.sqlState=error.code;
  if(/^[0-9]{1,6}$/.test(error.position||''))result.position=Number(error.position);
  return result;
}

export class QueryJob {
  constructor(config,input,{parameters=[],applicationName='schema-atlas-query'}={}){
    this.config=config;this.input=validateQuery(input);this.parameters=parameters;this.applicationName=applicationName;this.client=null;this.options=null;this.stopped=false;this.finished=false;
    this.interrupt=new Promise((resolve,reject)=>{this.resolveStop=resolve;this.rejectStop=reject;});
    // Cancellation may arrive during DNS/connect, before run attaches its race.
    this.interrupt.catch(()=>{});
  }
  stop(reason=new AtlasError('CANCELLED','Query cancelled.',409)){
    if(this.finished||this.stopped)return false;
    this.stopped=true;this.client?.connection.stream.pause();this.rejectStop(reason);return true;
  }
  async cancelBackend(){
    if(!this.client?.processID||!this.options)return;
    const cancel=new pg.Client({...this.options,password:()=>this.client.password,application_name:'schema-atlas-cancel',connectionTimeoutMillis:2000,statement_timeout:1500});
    cancel.on('error',()=>{});let timer;
    try{
      await Promise.race([(async()=>{await cancel.connect();await cancel.query('SELECT pg_catalog.pg_cancel_backend($1::integer)',[this.client.processID]);})(),
        new Promise((_,reject)=>{timer=setTimeout(()=>{cancel.connection.stream.destroy();reject(new Error('cancel timeout'));},3500);})]);
    }catch{/* Closing the query socket and the server statement timeout are fallbacks. */}
    finally{clearTimeout(timer);await cancel.end().catch(()=>{});}
  }
  async run(){
    const started=performance.now();let timer,wireBytes=0,wireListener;
    const rows=[];let fields=[],bytes=0;
    const result=(command,rowCount,truncated=false,reason=null)=>({columns:fields.map(f=>({name:f.name,typeOID:f.dataTypeID})),rows,rowCount,command,truncated,reason,limit:this.input.limit,readOnly:true});
    const work=async()=>{
      this.options={...await clientOptions(this.config),application_name:this.applicationName,statement_timeout:this.input.timeout};
      if(this.stopped)throw new AtlasError('CANCELLED','Query cancelled.',409);
      const client=new pg.Client(this.options);this.client=client;client.on('error',()=>{});
      await client.connect();if(this.stopped)throw new AtlasError('CANCELLED','Query cancelled.',409);
      wireListener=chunk=>{wireBytes+=chunk.length;if(wireBytes>QUERY_LIMITS.wireBytes)this.stop(new AtlasError('RESULT_LIMIT','The response exceeded 8 MB. Select fewer or smaller columns.',413));};
      // Count raw protocol bytes before pg accumulates a potentially huge field.
      client.connection.stream.prependListener('data',wireListener);
      await client.query('BEGIN READ ONLY');
      const output=await new Promise((resolve,reject)=>{
        const q=new pg.Query({text:this.input.sql,values:this.parameters,queryMode:'extended',rowMode:'array',types:{getTypeParser:()=>value=>value}});
        q.on('row',(row,metadata)=>{
          if(this.stopped)return;fields=metadata.fields;
          if(fields.length>QUERY_LIMITS.columns){this.stop(new AtlasError('RESULT_LIMIT','Select at most 200 columns.',413));return;}
          const size=Buffer.byteLength(JSON.stringify(row));
          if(rows.length>=this.input.limit||bytes+size>QUERY_LIMITS.resultBytes){
            this.stopped=true;client.connection.stream.pause();
            this.resolveStop(result('SELECT',rows.length,true,rows.length>=this.input.limit?'row limit':'2 MB result limit'));return;
          }
          bytes+=size;rows.push(row);
        });
        q.once('error',reject);q.once('end',r=>{fields=r.fields;if(fields.length>QUERY_LIMITS.columns)return reject(new AtlasError('RESULT_LIMIT','Select at most 200 columns.',413));resolve(result(r.command,r.rowCount??rows.length));});
        // The entire editor statement is intentional SQL, never interpolated into
        // application SQL. PostgreSQL parses it under this user's role and RLS.
        client.query(q);
      });
      await client.query('ROLLBACK');return output;
    };
    timer=setTimeout(()=>this.stop(new AtlasError('TIMEOUT','Query timed out. Reduce the query or choose a longer timeout.',504)),this.input.timeout+6000);
    try{
      const output=await Promise.race([work(),this.interrupt]);
      return {...output,milliseconds:Math.round(performance.now()-started)};
    }catch(error){throw queryError(error);}
    finally{
      this.finished=true;clearTimeout(timer);
      if(this.stopped)await this.cancelBackend();
      if(this.client){if(wireListener)this.client.connection.stream.removeListener('data',wireListener);if(this.stopped)this.client.connection.stream.destroy();await this.client.end().catch(()=>{});}
      this.config=null;this.options=null;
    }
  }
}

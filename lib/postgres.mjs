import pg from 'pg';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { diffModels } from './schema-diff.mjs';

export class AtlasError extends Error {
  constructor(code,message,status=400){super(message);this.code=code;this.status=status;}
}
const badInput=()=>new AtlasError('INPUT','Check the connection fields. Host, database and username are required; port must be between 1 and 65535.');
export function validateConnection(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw badInput();
  const allowed=new Set(['name','host','port','database','user','password','tls','ca']);
  if(Object.keys(input).some(k=>!allowed.has(k)))throw badInput();
  const string=(key,min,max,fallback)=>{
    const v=input[key]??fallback;if(typeof v!=='string'||v.length<min||Buffer.byteLength(v)>max||/[\u0000-\u001f\u007f]/u.test(v))throw badInput();return v;
  };
  const host=string('host',1,253).trim();
  if(!net.isIP(host)&&!host.split('.').every(label=>/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))throw badInput();
  const port=input.port??5432;if(!Number.isInteger(port)||port<1||port>65535)throw badInput();
  const database=string('database',1,128),user=string('user',1,128),password=string('password',0,4096,'');
  const mode=input.tls??'verify';if(!['verify','local'].includes(mode))throw badInput();
  const ca=input.ca??'';if(typeof ca!=='string'||Buffer.byteLength(ca)>32768||ca.includes('\0')||(ca&&!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(ca)))throw new AtlasError('INPUT','The CA field must contain PEM certificates (maximum 32 KB).');
  return {name:string('name',0,80,'').trim()||database,host,port,database,user,password,tls:mode,ca};
}
function ipv4Kind(address){
  const [a,b]=address.split('.').map(Number);
  if(a===127)return 'loopback';
  if(a===0||a>=224||a===169&&b===254||a===255)return 'blocked';
  return 'allowed';
}
export function addressKind(address){
  const family=net.isIP(address);if(family===4)return ipv4Kind(address);
  if(family!==6)return 'blocked';
  // WHATWG canonicalization also normalizes IPv4-mapped IPv6 forms.
  const normalized=new URL(`http://[${address}]/`).hostname.slice(1,-1).toLowerCase();
  if(normalized==='::1')return 'loopback';
  if(normalized.startsWith('::ffff:')){
    const tail=normalized.slice(7).split(':');if(tail.length!==2)return 'blocked';
    const n1=parseInt(tail[0],16),n2=parseInt(tail[1],16);return ipv4Kind(`${n1>>8}.${n1&255}.${n2>>8}.${n2&255}`);
  }
  if(normalized==='::'||/^fe[89ab]/.test(normalized)||normalized.startsWith('ff')||normalized.startsWith('::'))return 'blocked';
  return 'allowed';
}
export async function resolveTarget(config,lookup=dns.lookup){
  let timer;
  const records=await Promise.race([
    net.isIP(config.host)?Promise.resolve([{address:config.host,family:net.isIP(config.host)}]):lookup(config.host,{all:true,verbatim:true}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new AtlasError('CONNECTION','Could not resolve the PostgreSQL host.',502)),5000);})
  ]).finally(()=>clearTimeout(timer));
  if(!records.length||records.length>32||records.some(r=>addressKind(r.address)==='blocked'))throw new AtlasError('TARGET','This address is not an allowed PostgreSQL destination.');
  if(config.tls==='local'&&records.some(r=>addressKind(r.address)!=='loopback'))throw new AtlasError('TLS_REQUIRED','Remote PostgreSQL connections require verified TLS. Use the TLS option or an SSH tunnel to localhost.');
  // Private database networks are an intentional capability. Metadata/link-local and
  // multicast destinations are rejected. Dial the validated address, not a new DNS lookup.
  return records.find(r=>r.family===4)?.address||records[0].address;
}
export async function clientOptions(config,lookup){
  const address=await resolveTarget(config,lookup);
  const ssl=config.tls==='local'?false:{rejectUnauthorized:true,minVersion:'TLSv1.2',...(config.ca?{ca:config.ca}:{}),...(net.isIP(config.host)?{}:{servername:config.host}),checkServerIdentity:(_name,cert)=>tls.checkServerIdentity(config.host,cert)};
  // The callback prevents pg from falling back to PGPASSWORD or ~/.pgpass when
  // the browser intentionally supplies an empty password.
  return {host:address,port:config.port,database:config.database,user:config.user,password:()=>config.password,ssl,
    application_name:'schema-atlas',connectionTimeoutMillis:6000,statement_timeout:8000,lock_timeout:2000,
    idle_in_transaction_session_timeout:10000,options:'-c default_transaction_read_only=on',keepAlive:true};
}

const SOURCE={kind:'postgres',file:'PostgreSQL system catalog',line:null};
const qid=s=>/^[a-z_][a-z0-9_$]*$/.test(s)?s:`"${s.replaceAll('"','""')}"`;
const idOf=(schema,name)=>`${qid(schema)}.${qid(name)}`;
const action=c=>({a:'NO ACTION',r:'RESTRICT',c:'CASCADE',n:'SET NULL',d:'SET DEFAULT'}[c]||c);

// Each statement is fixed SQL. Database OIDs are passed as a single typed array parameter.
const SQL={
  info:`SELECT current_database() AS database, current_user AS username,
    current_setting('server_version') AS version, current_setting('server_version_num')::integer AS version_num,
    current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation,
    pg_catalog.pg_encoding_to_char(d.encoding) AS encoding, d.datcollate AS collation
    FROM pg_catalog.pg_database d WHERE d.datname = current_database()`,
  tables:`SELECT c.oid::bigint AS oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind,
    pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relpersistence AS persistence,
    c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security,
    c.relreplident AS replica_identity, c.reloptions AS options, c.relispartition AS is_partition,
    c.reltuples::bigint::text AS estimated_rows, ts.spcname AS tablespace,
    pg_catalog.left(pg_catalog.obj_description(c.oid,'pg_class'),4096) AS comment,
    CASE WHEN c.relkind IN ('r','m','p') THEN pg_catalog.pg_total_relation_size(c.oid)::text END AS total_bytes,
    CASE WHEN c.relkind IN ('r','m','p') THEN pg_catalog.pg_table_size(c.oid)::text END AS data_bytes,
    CASE WHEN c.relkind IN ('r','m','p') THEN pg_catalog.pg_indexes_size(c.oid)::text END AS index_bytes,
    CASE WHEN c.relkind IN ('v','m') THEN pg_catalog.left(pg_catalog.pg_get_viewdef(c.oid,true),12000) END AS view_definition,
    CASE WHEN c.relkind='p' THEN pg_catalog.pg_get_partkeydef(c.oid) END AS partition_key,
    CASE WHEN c.relispartition THEN pg_catalog.pg_get_expr(c.relpartbound,c.oid,true) END AS partition_bound,
    pt.partstrat AS partition_strategy, am.amname AS access_method
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid=c.reltablespace
    LEFT JOIN pg_catalog.pg_partitioned_table pt ON pt.partrelid=c.oid
    LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam
    WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_' AND pg_catalog.has_schema_privilege(n.oid,'USAGE')
    ORDER BY n.nspname,c.relname LIMIT 2001`,
  columns:`SELECT a.attrelid::bigint AS table_oid,a.attnum AS position,a.attname AS name,
    pg_catalog.format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null,
    pg_catalog.left(pg_catalog.pg_get_expr(d.adbin,d.adrelid),8000) AS default_value,
    a.attidentity AS identity,a.attgenerated AS generated, co.collname AS collation,
    pg_catalog.left(pg_catalog.col_description(a.attrelid,a.attnum),4096) AS comment,
    a.attstorage AS storage,a.attstattarget AS statistics_target,
    CASE WHEN t.typtype='e' THEN ARRAY(SELECT e.enumlabel::text FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid ORDER BY e.enumsortorder) END AS enum_values
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation
    WHERE a.attrelid=ANY($1::oid[]) AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY a.attrelid,a.attnum LIMIT 50001`,
  indexes:`SELECT i.indrelid::bigint AS table_oid, ci.relname AS name, am.amname AS method,
    i.indisunique AS unique,i.indisprimary AS primary,i.indisvalid AS valid,i.indisready AS ready,
    i.indisclustered AS clustered,i.indisreplident AS replica_identity,
    COALESCE((pg_catalog.to_jsonb(i)->>'indnullsnotdistinct')::boolean,false) AS nulls_not_distinct,
    pg_catalog.left(pg_catalog.pg_get_indexdef(i.indexrelid),12000) AS definition,
    pg_catalog.left(pg_catalog.pg_get_expr(i.indpred,i.indrelid),8000) AS predicate,
    ARRAY(SELECT pg_catalog.pg_get_indexdef(i.indexrelid,k,true) FROM pg_catalog.generate_series(1,i.indnkeyatts) k) AS columns,
    ARRAY(SELECT pg_catalog.pg_get_indexdef(i.indexrelid,k,true) FROM pg_catalog.generate_series(i.indnkeyatts+1,i.indnatts) k) AS included,
    ci.reloptions AS options,ts.spcname AS tablespace,
    pg_catalog.pg_relation_size(i.indexrelid)::text AS bytes,
    pg_catalog.left(pg_catalog.obj_description(i.indexrelid,'pg_class'),4096) AS comment
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ci ON ci.oid=i.indexrelid
    JOIN pg_catalog.pg_am am ON am.oid=ci.relam LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid=ci.reltablespace
    WHERE i.indrelid=ANY($1::oid[]) ORDER BY i.indrelid,ci.relname LIMIT 20001`,
  constraints:`SELECT c.conrelid::bigint AS table_oid,c.oid::bigint AS oid,c.conname AS name,c.contype AS type,
    c.conkey AS keys,c.confkey AS target_keys,c.confrelid::bigint AS target_oid,
    tn.nspname AS target_schema,tc.relname AS target_table,
    ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY k(num,ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS target_columns,
    c.confdeltype AS on_delete,c.confupdtype AS on_update,c.confmatchtype AS match_type,
    c.condeferrable AS deferrable,c.condeferred AS initially_deferred,c.convalidated AS validated,
    c.conparentid::bigint AS parent_constraint,
    pg_catalog.left(pg_catalog.pg_get_constraintdef(c.oid,true),12000) AS definition
    FROM pg_catalog.pg_constraint c LEFT JOIN pg_catalog.pg_class tc ON tc.oid=c.confrelid
    LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=tc.relnamespace
    WHERE c.conrelid=ANY($1::oid[]) ORDER BY c.conrelid,c.conname LIMIT 20001`,
  inheritance:`SELECT i.inhrelid::bigint AS child_oid,i.inhparent::bigint AS parent_oid,
    pn.nspname AS parent_schema,p.relname AS parent_name,cn.nspname AS child_schema,c.relname AS child_name,
    c.relispartition AS is_partition,pg_catalog.pg_get_expr(c.relpartbound,c.oid,true) AS bound
    FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class p ON p.oid=i.inhparent
    JOIN pg_catalog.pg_namespace pn ON pn.oid=p.relnamespace JOIN pg_catalog.pg_class c ON c.oid=i.inhrelid
    JOIN pg_catalog.pg_namespace cn ON cn.oid=c.relnamespace
    WHERE i.inhrelid=ANY($1::oid[]) OR i.inhparent=ANY($1::oid[])
    ORDER BY i.inhparent,i.inhrelid LIMIT 20001`,
  triggers:`SELECT t.tgrelid::bigint AS table_oid,t.tgname AS name,t.tgenabled AS enabled,
    pg_catalog.left(pg_catalog.pg_get_triggerdef(t.oid,true),12000) AS definition
    FROM pg_catalog.pg_trigger t WHERE t.tgrelid=ANY($1::oid[]) AND NOT t.tgisinternal
    ORDER BY t.tgrelid,t.tgname LIMIT 10001`,
  policies:`SELECT p.polrelid::bigint AS table_oid,p.polname AS name,p.polcmd AS command,p.polpermissive AS permissive,
    ARRAY(SELECT CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(r)::text END FROM pg_catalog.unnest(p.polroles) r) AS roles,
    pg_catalog.left(pg_catalog.pg_get_expr(p.polqual,p.polrelid),8000) AS using_expression,
    pg_catalog.left(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),8000) AS check_expression
    FROM pg_catalog.pg_policy p WHERE p.polrelid=ANY($1::oid[]) ORDER BY p.polrelid,p.polname LIMIT 10001`,
  grants:`SELECT c.oid::bigint AS table_oid,
    CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END AS grantee,
    pg_catalog.pg_get_userbyid(x.grantor) AS grantor,x.privilege_type AS privilege,x.is_grantable AS grantable
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) x
    WHERE c.oid=ANY($1::oid[]) ORDER BY c.oid,x.grantee,x.privilege_type LIMIT 30001`
};
const rowLimits={info:1,tables:2000,columns:50000,indexes:20000,constraints:20000,inheritance:20000,triggers:10000,policies:10000,grants:30000};

function boundedQuery(client,text,values,budget,maxRows){
  return new Promise((resolve,reject)=>{
    const rows=[];let settled=false;
    const query=new pg.Query({text,values});
    const finish=(error)=>{if(settled)return;settled=true;error?reject(error):resolve(rows);};
    query.on('row',row=>{
      if(settled)return;
      budget.bytes+=Buffer.byteLength(JSON.stringify(row));
      if(rows.length>=maxRows||budget.bytes>16_000_000){finish(new AtlasError('SCAN_LIMIT','This schema exceeds the current limit (2,000 tables or 16 MB of metadata).',422));void client.end().catch(()=>{});return;}
      rows.push(row);
    });
    query.on('error',finish);query.on('end',()=>finish());client.query(query);
  });
}
export function catalogModel(data,config,id){
  const tables=[],byOID=new Map(),relationships=[];
  for(const r of data.tables){
    const t={id:idOf(r.schema,r.name),name:r.name,prefix:r.schema,origin:'postgres',kind:({r:'table',p:'partitioned table',v:'view',m:'materialized view',f:'foreign table'})[r.kind],columns:[],primaryKey:[],indexes:[],constraints:[],partitions:[],sources:[SOURCE],comment:r.comment,
      options:{owner:r.owner,accessMethod:r.access_method,persistence:({p:'permanent',u:'unlogged',t:'temporary'})[r.persistence],rowSecurity:r.row_security,forceRowSecurity:r.force_row_security,replicaIdentity:({d:'default',n:'nothing',f:'full',i:'index'})[r.replica_identity],tablespace:r.tablespace||'database default',storageParameters:r.options||[]},
      statistics:{estimatedRows:r.estimated_rows==='-1'?null:r.estimated_rows,totalBytes:r.total_bytes,dataBytes:r.data_bytes,indexBytes:r.index_bytes},triggers:[],policies:[],grants:[],viewDefinition:r.view_definition,partitionOf:null};
    if(r.partition_strategy)t.partitions.push({type:'strategy',strategy:({r:'range',l:'list',h:'hash'})[r.partition_strategy],key:r.partition_key,source:SOURCE});
    if(r.is_partition)t.options.partitionBound=r.partition_bound;
    tables.push(t);byOID.set(r.oid,t);
  }
  for(const c of data.columns){const t=byOID.get(c.table_oid);if(!t)continue;t.columns.push({name:c.name,position:c.position,type:c.type,nullable:!c.not_null,primaryKey:false,default:c.default_value,origin:'postgres',source:SOURCE,reference:null,references:[],options:{identity:({a:'always',d:'by default'})[c.identity]||null,generated:c.generated||null,collation:c.collation,comment:c.comment,storage:({p:'plain',e:'external',m:'main',x:'extended'})[c.storage],statisticsTarget:c.statistics_target,...(c.enum_values?{enumValues:c.enum_values}:{})}});}
  for(const i of data.indexes){const t=byOID.get(i.table_oid);if(!t)continue;t.indexes.push({name:i.name,columns:i.columns,unique:i.unique,primary:i.primary,using:i.method,where:i.predicate,include:i.included,definition:i.definition,source:SOURCE,options:{valid:i.valid,ready:i.ready,clustered:i.clustered,replicaIdentity:i.replica_identity,nullsNotDistinct:i.nulls_not_distinct,tablespace:i.tablespace||'database default',storageParameters:i.options||[],comment:i.comment},statistics:{bytes:i.bytes}});}
  for(const c of data.constraints){
    const t=byOID.get(c.table_oid);if(!t)continue;
    const cols=(c.keys||[]).map(pos=>t.columns.find(v=>v.position===pos)?.name).filter(v=>v!==undefined);
    const constraint={name:c.name,type:({p:'primary key',u:'unique',f:'foreign key',c:'check',x:'exclusion',n:'not null'})[c.type]||c.type,definition:c.definition,columns:cols,options:{deferrable:c.deferrable,initiallyDeferred:c.initially_deferred,validated:c.validated,inherited:!!c.parent_constraint&&c.parent_constraint!=='0'},source:SOURCE};t.constraints.push(constraint);
    if(c.type==='p'){t.primaryKey=cols;for(const col of t.columns)col.primaryKey=cols.includes(col.name);}
    if(c.type==='f'){
      const target=idOf(c.target_schema,c.target_table),targetColumns=c.target_columns||[];
      const r={id:`${t.id}:${c.name}`,name:c.name,from:t.id,to:target,columns:cols,targetColumns,column:cols[0],targetColumn:targetColumns[0],kind:'foreign_key',onDelete:action(c.on_delete),onUpdate:action(c.on_update),match:({f:'FULL',p:'PARTIAL',s:'SIMPLE'})[c.match_type],deferrable:c.deferrable,initiallyDeferred:c.initially_deferred,validated:c.validated,inherited:!!c.parent_constraint&&c.parent_constraint!=='0',resolved:byOID.has(c.target_oid),source:SOURCE};r.cardinality=t.indexes.some(i=>i.unique&&i.options.valid&&!i.where&&i.columns.length&&i.columns.every(name=>cols.includes(name)))?'one_to_one':'many_to_one';r.optional=cols.some(name=>t.columns.find(col=>col.name===name)?.nullable);relationships.push(r);
      cols.forEach((name,i)=>{const col=t.columns.find(x=>x.name===name);const ref={table:target,column:targetColumns[i],name:c.name,onDelete:r.onDelete,onUpdate:r.onUpdate,columns:cols,targetColumns,match:r.match,deferrable:r.deferrable};col.references.push(ref);col.reference??=ref;});
    }
  }
  for(const i of data.inheritance){const child=byOID.get(i.child_oid),parent=byOID.get(i.parent_oid);if(i.is_partition){if(child){child.partitionOf=idOf(i.parent_schema,i.parent_name);child.options.partitionBound=i.bound;}if(parent)parent.partitions.push({type:'child',name:idOf(i.child_schema,i.child_name),bound:i.bound,source:SOURCE});}else if(child){child.options.inherits??=[];child.options.inherits.push(idOf(i.parent_schema,i.parent_name));}}
  for(const [key,rows]of Object.entries({triggers:data.triggers,policies:data.policies,grants:data.grants}))for(const row of rows){const {table_oid,...rest}=row;byOID.get(table_oid)?.[key].push(rest);}
  const info=data.info[0];
  return {formatVersion:1,capabilities:{provider:'postgres',query:true,queryMode:'read-only',refresh:true},tables,relationships,warnings:[],
    repository:{id,name:config.name,path:`${config.host}:${config.port}/${config.database}`,provider:'postgres'},
    database:{name:info.database,username:info.username,host:config.host,port:config.port,version:info.version,encoding:info.encoding,collation:info.collation,tls:config.tls==='verify',readOnly:info.read_only==='on',isolation:info.isolation},
    coverage:{mode:'live',note:'Live PostgreSQL catalog snapshot. Includes ordinary and partitioned tables, views, columns, all indexes, constraints, partitions, triggers, policies and table grants in accessible non-system schemas. No table data is read.',metadataNotes:'Estimated row counts come from PostgreSQL statistics. Exact row counts are not queried. Table grants show catalog ACL entries, not expanded inherited role privileges. Long comments and definitions have display limits.'}};
}

export class PostgresProvider {
  constructor(config,id){this.config=config;this.id=id;this.name=config.name;this.snapshot=null;this.pending=null;this.client=null;this.closed=false;}
  publicInfo(){return {id:this.id,name:this.name,host:this.config.host,port:this.config.port,database:this.config.database,user:this.config.user,tls:this.config.tls,provider:'postgres'};}
  async inspect(){if(this.closed)throw new AtlasError('NOT_FOUND','Connection is closed.',404);if(this.pending)return this.pending;this.pending=this.scan().finally(()=>{this.pending=null;});return this.pending;}
  async scan(){
    const start=performance.now();let timer;const data={},budget={bytes:0};
    try{
      const options=await clientOptions(this.config);if(this.closed)throw new AtlasError('NOT_FOUND','Connection is closed.',404);
      const client=new pg.Client(options);this.client=client;client.on('error',()=>{});
      const scan=async()=>{
        await client.connect();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query('SET LOCAL search_path TO pg_catalog');
        data.info=await boundedQuery(client,SQL.info,[],budget,rowLimits.info);
        if(data.info[0].version_num<120000)throw new AtlasError('VERSION','PostgreSQL 12 or newer is required.',422);
        if(data.info[0].read_only!=='on')throw new AtlasError('CONNECTION','Could not establish a read-only catalog transaction.',502);
        data.tables=await boundedQuery(client,SQL.tables,[],budget,rowLimits.tables);
        const oids=data.tables.map(t=>t.oid);
        for(const name of ['columns','indexes','constraints','inheritance','triggers','policies','grants'])data[name]=oids.length?await boundedQuery(client,SQL[name],[oids],budget,rowLimits[name]):[];
        await client.query('COMMIT');
      };
      await Promise.race([scan(),new Promise((_,reject)=>{timer=setTimeout(()=>{void client.end().catch(()=>{});reject(new AtlasError('TIMEOUT','The catalog scan timed out. The previous diagram is retained.',504));},25000);})]);
      if(this.closed)throw new AtlasError('NOT_FOUND','Connection is closed.',404);
      const model=catalogModel(data,this.config,this.id);
      // Volatile size/row estimates are visible metadata but do not represent DDL changes.
      const fingerprint=JSON.stringify({tables:model.tables,relationships:model.relationships},(key,value)=>key==='statistics'?undefined:value);
      model.revision=createHash('sha256').update(fingerprint).digest('hex').slice(0,12);
      model.scannedAt=new Date().toISOString();model.scan={milliseconds:Math.round(performance.now()-start),bytes:budget.bytes,queries:data.tables.length?12:5,tables:model.tables.length};
      model.changes=diffModels(this.snapshot,model);this.snapshot=model;return model;
    }catch(error){if(error instanceof AtlasError)throw error;throw new AtlasError('CONNECTION','Could not connect or read PostgreSQL metadata. Check the host, port, database, credentials, network access and TLS/CA settings. The previous diagram is retained.',502);}
    finally{clearTimeout(timer);if(this.client){await this.client.end().catch(()=>{});this.client=null;}}
  }
  async close(){this.closed=true;this.snapshot=null;this.config.password='';this.config.ca='';if(this.client)await this.client.end().catch(()=>{});}
}

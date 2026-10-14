// Static Ecto interpreter. This walks syntax and replays known DDL, never Elixir code.
export const call = n => n?.call?.atom ?? (typeof n?.call === 'string' ? n.call : null);
const args = n => Array.isArray(n?.args) ? n.args : [];
const block = n => call(n) === '__block__' ? args(n) : n == null ? [] : [n];
const isPairs = n => Array.isArray(n) && n.every(p => Array.isArray(p) && p.length === 2 && p[0]?.atom);
const options = n => isPairs(n) ? Object.fromEntries(n.map(([k,v]) => [k.atom,v])) : {};
const body = n => options(args(n).at(-1)).do;
const literal = (n, env = {}) => {
  if (n == null || typeof n !== 'object') return n;
  if (n.atom) return n.atom;
  if (Array.isArray(n)) return isPairs(n) ? Object.fromEntries(n.map(([k,v]) => [k.atom,literal(v,env)])) : n.map(v => literal(v,env));
  if (call(n) === '__aliases__') {const parts=args(n).map(v=>literal(v,env));if(env.aliases?.[parts[0]])parts[0]=env.aliases[parts[0]];return parts.join('.');}
  if (call(n) === '@') return env[call(args(n)[0])] ?? { expression: '@' + call(args(n)[0]) };
  if (call(n) === '%{}') return Object.fromEntries(args(n).filter(v=>Array.isArray(v)&&v.length===2).map(([k,v])=>[text(literal(k,env))||'?',literal(v,env)]));
  if (call(n) === '{}') return args(n).map(v => literal(v,env));
  if (call(n) === '-' && typeof args(n)[0] === 'number') return -args(n)[0];
  if (call(n) && n.args === null) return env[call(n)] ?? { expression: call(n) };
  if (call(n) === 'fragment') return { expression: literal(args(n)[0],env) };
  return { expression: call(n) || 'dynamic expression' };
};
const optValues = (n, env) => Object.fromEntries(Object.entries(options(n)).map(([k,v]) => [k,literal(v,env)]));
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : null;
const typeName = n => {
  const v = literal(n);
  if (Array.isArray(v)) return v[0] === 'array' ? `${text(v[1]) || 'unknown'}[]` : v.map(x => text(x) || '?').join(':');
  return text(v) || (v?.expression ? `custom (${v.expression})` : 'unknown');
};
const sqlType = t => ({ string:'varchar', binary_id:'uuid', id:'bigint', serial:'integer', bigserial:'bigint', binary:'bytea', map:'jsonb', naive_datetime:'timestamp', naive_datetime_usec:'timestamp(6)', utc_datetime:'timestamptz', utc_datetime_usec:'timestamptz(6)' }[t] || t);
const source = (ctx, n) => ({ file: ctx.file, line: n?.line || 1, kind: ctx.kind });
const tableID = (name, prefix = 'public') => `${prefix || 'public'}.${name}`;
const identifier = s => typeof s === 'string' && s.length > 0 && s.length <= 200;

export function buildModel(parsed) {
  const tables = new Map(), warnings = [], migrations = [], modules = new Map(), droppedTables = new Set(), removedColumns = new Map();
  function warn(ctx, n, message) {
    if (warnings.length < 2000) warnings.push({ ...source(ctx,n), message });
  }
  function ensure(name, prefix, ctx, n, origin = 'migration') {
    if (!identifier(name) || (prefix != null && !identifier(prefix))) { warn(ctx,n,'Dynamic table or schema name could not be resolved.'); return null; }
    const id = tableID(name,prefix);
    if (!tables.has(id)) tables.set(id, { id, name, prefix:prefix || 'public', origin, columns:[], primaryKey:[], indexes:[], constraints:[], partitions:[], associations:[], sources:[], schemaModules:[], options:{}, comment:null });
    const t = tables.get(id), s = source(ctx,n);
    if (!t.sources.some(x => x.file === s.file && x.line === s.line)) t.sources.push(s);
    return t;
  }
  function descriptor(n,ctx) {
    const a = args(n), o = optValues(a.at(-1),ctx.env);
    return { name:text(literal(a[0],ctx.env)), prefix:o.prefix || ctx.env?.schema_prefix || 'public', options:o };
  }
  function findTable(n,ctx) {
    const d = descriptor(n,ctx);
    return ensure(d.name,d.prefix,ctx,n);
  }
  function addColumn(t,n,ctx,replace = false) {
    const a = args(n), name = text(literal(a[0],ctx.env));
    if (!identifier(name)) { warn(ctx,n,'Dynamic column name could not be resolved.'); return; }
    removedColumns.get(t.id)?.delete(name);
    const o = optValues(a.at(-1),ctx.env), refNode = call(a[1]) === 'references' ? a[1] : null;
    const ro = refNode ? optValues(args(refNode).at(-1),ctx.env) : {};
    const old = t.columns.find(c => c.name === name);
    const ectoType = refNode ? ro.type || 'bigint' : typeName(a[1]);
    const c = { name, type:sqlType(ectoType), ectoType, nullable:o.primary_key ? false : (o.null ?? old?.nullable ?? true), primaryKey:o.primary_key ?? old?.primaryKey ?? false, default:o.default ?? (Object.hasOwn(o,'default') ? null : old?.default ?? null), options:{...old?.options,...o}, source:source(ctx,n), origin:'migration', reference: refNode ? { table:tableID(text(literal(args(refNode)[0],ctx.env)),ro.prefix || t.prefix), column:ro.column || 'id', onDelete:ro.on_delete || 'nothing', onUpdate:ro.on_update || 'nothing', name:ro.name || `${t.name}_${name}_fkey`, ...ro } : replace ? null : old?.reference ?? null };
    if (old) Object.assign(old,c); else t.columns.push(c);
    t.primaryKey = t.columns.filter(c => c.primaryKey).map(c => c.name);
  }
  function tableCommands(t,n,ctx) {
    for (const cmd of block(n)) {
      const name = call(cmd), a = args(cmd);
      if (['add','add_if_not_exists','modify'].includes(name)) { if (name === 'add_if_not_exists' && t.columns.some(c => c.name === literal(a[0],ctx.env))) continue; addColumn(t,cmd,ctx,name === 'modify'); }
      else if (['remove','remove_if_exists'].includes(name)) {
        const column = text(literal(a[0],ctx.env));
        if(!removedColumns.has(t.id))removedColumns.set(t.id,new Set());removedColumns.get(t.id).add(column);
        t.columns = t.columns.filter(c => c.name !== column);
        t.indexes = t.indexes.filter(i => !i.columns.includes(column));
        t.primaryKey = t.columns.filter(c => c.primaryKey).map(c => c.name);
      } else if (name === 'timestamps') {
        const o = optValues(a[0],ctx.env);
        for (const key of ['inserted_at','updated_at']) if (o[key] !== false) addColumn(t,{call:{atom:'add'},line:cmd.line,args:[{atom:o[key] || key},{atom:o.type || 'naive_datetime'},[[{atom:'null'},o.null ?? false]]]},ctx);
      } else warn(ctx,cmd,`Table operation ${name || 'expression'} requires manual review.`);
    }
  }
  function index(n,ctx,action) {
    const a=args(n), o=optValues(a.at(-1),ctx.env), name=text(literal(a[0],ctx.env));
    const t=ensure(name,o.prefix || 'public',ctx,n); if(!t)return;
    const cols=literal(a[1],ctx.env), columns=Array.isArray(cols) ? cols.map(v => text(v) || '[expression]') : [];
    const idxName=o.name || `${name}_${columns.join('_').replace(/\W/g,'_')}_index`;
    if(action === 'drop') { t.indexes=t.indexes.filter(i=>i.name!==idxName); return; }
    const idx={name:idxName,columns,unique:call(n)==='unique_index'||o.unique===true,using:o.using||'btree',where:o.where||null,include:o.include||[],concurrently:o.concurrently||false,options:o,source:source(ctx,n)};
    t.indexes=t.indexes.filter(i=>i.name!==idxName);t.indexes.push(idx);
  }
  function constraint(n,ctx,action) {
    const a=args(n),o=optValues(a.at(-1),ctx.env),t=ensure(text(literal(a[0],ctx.env)),o.prefix||'public',ctx,n);if(!t)return;
    const name=text(literal(a[1],ctx.env));
    t.constraints=t.constraints.filter(c=>c.name!==name);
    if(action!=='drop')t.constraints.push({name,type:o.check?'check':o.exclude?'exclude':'constraint',definition:o.check||o.exclude||null,options:o,source:source(ctx,n)});
  }
  function renameColumn(t,from,to) {
    if(!removedColumns.has(t.id))removedColumns.set(t.id,new Set());removedColumns.get(t.id).add(from);removedColumns.get(t.id).delete(to);
    const c=t.columns.find(c=>c.name===from); if(c)c.name=to;
    t.primaryKey=t.primaryKey.map(v=>v===from?to:v);
    for(const i of t.indexes)i.columns=i.columns.map(v=>v===from?to:v);
    for(const other of tables.values())for(const col of other.columns)if(col.reference?.table===t.id&&col.reference.column===from)col.reference.column=to;
  }
  function renameTable(t,d) {
    const old=t.id;tables.delete(old);droppedTables.add(old);t.name=d.name;t.prefix=d.prefix;t.id=tableID(d.name,d.prefix);droppedTables.delete(t.id);tables.set(t.id,t);if(removedColumns.has(old)){removedColumns.set(t.id,removedColumns.get(old));removedColumns.delete(old);}
    for(const other of tables.values())for(const c of other.columns)if(c.reference?.table===old)c.reference.table=t.id;
  }
  function migrationCommand(n,ctx) {
    const name=call(n),a=args(n);
    if(['create','create_if_not_exists','alter','drop','drop_if_exists'].includes(name)) {
      const what=a[0],kind=call(what),action=name.startsWith('drop')?'drop':'create';
      if(kind==='table') {
        const d=descriptor(what,ctx),id=tableID(d.name,d.prefix);
        if(action==='drop'){tables.delete(id);droppedTables.add(id);return;}
        if(name==='create_if_not_exists'&&tables.has(id))return;
        const t=ensure(d.name,d.prefix,ctx,n);if(!t)return;
        if(name.startsWith('create')) {
          droppedTables.delete(id);
          t.options={...d.options};t.comment=d.options.comment||null;
          if(d.options.primary_key!==false&&!t.columns.some(c=>c.primaryKey))addColumn(t,{line:n.line,args:[{atom:'id'},{atom:'bigserial'},[[{atom:'primary_key'},true]]]},ctx);
          if(typeof d.options.options==='string')parsePartition(t,d.options.options,ctx,n);
        }
        tableCommands(t,body(n),ctx);
      } else if(['index','unique_index'].includes(kind))index(what,ctx,action);
      else if(kind==='constraint')constraint(what,ctx,action);
      else warn(ctx,n,'DDL target could not be resolved.');
    } else if(name==='rename') {
      const t=findTable(a[0],ctx);if(!t)return;
      if(a.length===2&&options(a[1]).to)renameTable(t,descriptor(options(a[1]).to,ctx));
      else {const to=text(literal(options(a.at(-1)).to,ctx.env));if(to)renameColumn(t,text(literal(a[1],ctx.env)),to);else warn(ctx,n,'Rename target could not be resolved.');}
    } else if(name==='execute') {
      const sql=literal(a[0],ctx.env);
      if(typeof sql==='string'&&!sql.includes('#{'))parseSQL(sql,ctx,n);
      else warn(ctx,n,'Dynamic SQL requires manual review; its effects are not applied.');
    } else if(name==='='&&call(a[0]))ctx.env[call(a[0])]=literal(a[1],ctx.env);
    else if(['flush','@'].includes(name))return;
    else warn(ctx,n,`Migration operation ${name||'expression'} is not statically interpreted; review this source.`);
  }

  function parsePartition(t,sql,ctx,n) {
    const m=sql.match(/PARTITION\s+BY\s+(RANGE|LIST|HASH)\s*\(([^)]+)\)/i);
    if(m)t.partitions.push({type:'strategy',strategy:m[1].toLowerCase(),key:m[2].trim(),source:source(ctx,n)});
  }
  function sqlID(s) { return s.split('.').map(v=>v.replace(/^"|"$/g,'').replace(/""/g,'"')); }
  function sqlTable(s,ctx,n) {const p=sqlID(s);return ensure(p.at(-1),p.length>1?p.at(-2):'public',ctx,n);}
  const ident='(?:"[^"\\r\\n]+"|[a-zA-Z_][\\w$]*)(?:\\.(?:"[^"\\r\\n]+"|[a-zA-Z_][\\w$]*))?';
  function parseSQL(sql,ctx,n) {
    if(sql.length>100000){warn(ctx,n,'SQL is too large to interpret.');return;}
    for(const statement of splitSQL(sql,';')) {
      const s=statement.trim();if(!s)continue;
      let m;
      if((m=s.match(new RegExp(`^CREATE\\s+TABLE\\s+(?:IF NOT EXISTS\\s+)?(${ident})\\s+PARTITION\\s+OF\\s+(${ident})\\s+([\\s\\S]+)$`,'i')))) {
        const parent=sqlTable(m[2],ctx,n),child=sqlTable(m[1],ctx,n);if(!parent||!child)continue;
        const p={type:'child',name:child.id,bound:m[3],source:source(ctx,n)};parent.partitions.push(p);child.partitionOf=parent.id;child.options.partitionOf=parent.id;child.options.partitionBound=m[3];
      } else if((m=s.match(new RegExp(`^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(CONCURRENTLY\\s+)?(?:IF NOT EXISTS\\s+)?(${ident})\\s+ON\\s+(${ident})\\s+(?:USING\\s+(\\w+)\\s*)?\\(([\\s\\S]+)$`,'i')))) {
        const t=sqlTable(m[4],ctx,n);if(!t)continue;
        const close=findClosing('('+m[6],0),content=m[6].slice(0,close-1),tail=m[6].slice(close);
        if(close<0){warn(ctx,n,'SQL index expression could not be resolved.');continue;}
        const name=sqlID(m[3]).at(-1);t.indexes=t.indexes.filter(i=>i.name!==name);
        t.indexes.push({name,columns:splitSQL(content,',').map(x=>x.trim().replace(/^"|"$/g,'')),unique:!!m[1],concurrently:!!m[2],using:m[5]||'btree',where:tail.match(/\bWHERE\s+([\s\S]+)/i)?.[1]||null,include:splitSQL(tail.match(/\bINCLUDE\s*\(([^)]+)\)/i)?.[1]||'',',').filter(Boolean),options:{sql:true},definition:s,source:source(ctx,n)});
      } else if((m=s.match(new RegExp(`^DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF EXISTS\\s+)?(${ident})(?:\\s+CASCADE)?$`,'i')))) {
        const parts=sqlID(m[1]);for(const t of tables.values())if(parts.length===1||t.prefix===parts[0])t.indexes=t.indexes.filter(i=>i.name!==parts.at(-1));
      } else if((m=s.match(new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${ident})\\s+([\\s\\S]+)$`,'i')))) {
        const t=sqlTable(m[1],ctx,n);if(!t)continue;const rest=m[2];let c;
        if((c=rest.match(new RegExp(`^ATTACH\\s+PARTITION\\s+(${ident})\\s+([\\s\\S]+)$`,'i')))) {
          const child=sqlTable(c[1],ctx,n);t.partitions.push({type:'child',name:child.id,bound:c[2],source:source(ctx,n)});child.partitionOf=t.id;child.options.partitionOf=t.id;
        } else if((c=rest.match(new RegExp(`^DETACH\\s+PARTITION\\s+(${ident})`,'i')))) {
          const child=sqlTable(c[1],ctx,n);t.partitions=t.partitions.filter(p=>p.name!==child.id);delete child.partitionOf;delete child.options.partitionOf;
        } else if((c=rest.match(/^ADD\s+CONSTRAINT\s+("[^"]+"|\w+)\s+(CHECK|EXCLUDE|UNIQUE|PRIMARY KEY|FOREIGN KEY)\s+([\s\S]+)/i))) {
          const name=c[1].replaceAll('"',''),type=c[2].toLowerCase();t.constraints=t.constraints.filter(x=>x.name!==name);t.constraints.push({name,type,definition:c[3],source:source(ctx,n)});
          if(type==='primary key'){const cols=c[3].match(/^\(([^)]+)\)/)?.[1];if(cols){t.primaryKey=splitSQL(cols,',').map(x=>x.trim().replaceAll('"',''));for(const col of t.columns)col.primaryKey=t.primaryKey.includes(col.name);}}
          if(type==='foreign key') {
            const fk=c[3].match(new RegExp(`^\\(([^)]+)\\)\\s+REFERENCES\\s+(${ident})\\s*\\(([^)]+)\\)([\\s\\S]*)$`,'i'));
            if(fk){const to=sqlID(fk[2]),columns=splitSQL(fk[1],','),targets=splitSQL(fk[3],',');columns.forEach((v,i)=>{const col=t.columns.find(x=>x.name===v.trim().replaceAll('"',''));if(col)col.reference={table:tableID(to.at(-1),to.length>1?to.at(-2):t.prefix),column:targets[i]?.trim().replaceAll('"',''),name,onDelete:fk[4].match(/ON DELETE (CASCADE|SET NULL|RESTRICT|NO ACTION)/i)?.[1]||'NO ACTION',onUpdate:fk[4].match(/ON UPDATE (CASCADE|SET NULL|RESTRICT|NO ACTION)/i)?.[1]||'NO ACTION'};});}
          }
        } else if((c=rest.match(/^DROP\s+CONSTRAINT\s+(?:IF EXISTS\s+)?("[^"]+"|\w+)/i))) {
          const name=c[1].replaceAll('"','');t.constraints=t.constraints.filter(x=>x.name!==name);for(const col of t.columns)if(col.reference?.name===name)col.reference=null;
        } else if((c=rest.match(/^RENAME\s+COLUMN\s+("[^"]+"|\w+)\s+TO\s+("[^"]+"|\w+)$/i)))renameColumn(t,c[1].replaceAll('"',''),c[2].replaceAll('"',''));
        else if((c=rest.match(/^ALTER\s+(?:COLUMN\s+)?("[^"]+"|\w+)\s+(SET NOT NULL|DROP NOT NULL|SET DEFAULT [\s\S]+|DROP DEFAULT|TYPE [\s\S]+)$/i))) {
          const col=t.columns.find(x=>x.name===c[1].replaceAll('"',''));if(col){const op=c[2].toUpperCase();if(op==='SET NOT NULL')col.nullable=false;else if(op==='DROP NOT NULL')col.nullable=true;else if(op==='DROP DEFAULT')col.default=null;else if(op.startsWith('SET DEFAULT'))col.default={expression:c[2].slice(12)};else col.type=c[2].slice(5).split(/\s+USING\s+/i)[0];}
        } else warn(ctx,n,'ALTER TABLE SQL requires manual review; only supported DDL is applied.');
      } else if((m=s.match(new RegExp(`^CREATE\\s+TABLE\\s+(?:IF NOT EXISTS\\s+)?(${ident})\\s*\\(([\\s\\S]+)$`,'i')))) {
        const t=sqlTable(m[1],ctx,n);if(!t)continue;const open='('+m[2],end=findClosing(open,0);if(end<0){warn(ctx,n,'CREATE TABLE SQL could not be resolved.');continue;}
        for(const def of splitSQL(open.slice(1,end),',')) {
          const c=def.trim().match(/^("[^"]+"|[a-zA-Z_]\w*)\s+([\s\S]+)$/);if(!c)continue;
          if(/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)$/i.test(c[1])){t.constraints.push({name:'table constraint',type:'sql',definition:def.trim(),source:source(ctx,n)});warn(ctx,n,'Table-level SQL constraint is preserved as metadata; relationship inference may be incomplete.');continue;}
          const colName=c[1].replaceAll('"',''),colType=c[2].split(/\s+(?:NOT NULL|NULL|DEFAULT|PRIMARY KEY|REFERENCES|CHECK|UNIQUE)\b/i)[0];
          const ref=c[2].match(new RegExp(`REFERENCES\\s+(${ident})\\s*\\(([^)]+)\\)`,'i'));
          t.columns.push({name:colName,type:colType,ectoType:null,nullable:!(/NOT NULL|PRIMARY KEY/i.test(c[2])),primaryKey:/PRIMARY KEY/i.test(c[2]),default:c[2].match(/DEFAULT\s+(.+?)(?=\s+(?:NOT NULL|PRIMARY KEY|CHECK|REFERENCES)|$)/i)?.[1]||null,options:{sql:true},origin:'migration',source:source(ctx,n),reference:ref?{table:tableID(sqlID(ref[1]).at(-1),sqlID(ref[1]).length>1?sqlID(ref[1])[0]:t.prefix),column:ref[2].replaceAll('"',''),onDelete:'unknown',onUpdate:'unknown'}:null});
        }
        t.primaryKey=t.columns.filter(c=>c.primaryKey).map(c=>c.name);parsePartition(t,open.slice(end+1),ctx,n);
      } else if((m=s.match(new RegExp(`^DROP\\s+TABLE\\s+(?:IF EXISTS\\s+)?(${ident})(?:\\s+CASCADE)?$`,'i')))) { const p=sqlID(m[1]),id=tableID(p.at(-1),p.length>1?p[0]:'public');tables.delete(id);droppedTables.add(id); }
      else if((m=s.match(new RegExp(`^COMMENT\\s+ON\\s+TABLE\\s+(${ident})\\s+IS\\s+'([\\s\\S]*)'$`,'i')))){const t=sqlTable(m[1],ctx,n);if(t)t.comment=m[2].replaceAll("''", "'");}
      else if(/^(?:INSERT|UPDATE|DELETE|SELECT|SET|CREATE EXTENSION|CREATE SCHEMA)\b/i.test(s)) { /* DML and session commands do not define this metadata. */ }
      else warn(ctx,n,'SQL statement requires manual review; it was not applied to the diagram.');
    }
  }

  function moduleNodes(ast) {
    const out=[];for(const n of block(ast)){if(call(n)==='defmodule')out.push(n);else if(call(n)==='__block__')out.push(...moduleNodes(n));}return out;
  }
  function moduleContext(file,mod) {
    const env={aliases:{}};for(const n of block(body(mod))){
      if(call(n)==='@'){const attr=args(n)[0];env[call(attr)]=literal(args(attr)[0],env);}
      if(call(n)==='alias'){const full=literal(args(n)[0],env),as=optValues(args(n).at(-1),env).as;if(typeof full==='string')env.aliases[as||full.split('.').at(-1)]=full;}
    }
    return {file:file.path,kind:file.kind,env,module:literal(args(mod)[0])};
  }
  const migrationFiles=parsed.filter(f=>f.kind==='migration').sort((a,b)=>pathVersion(a.path).localeCompare(pathVersion(b.path))||a.path.localeCompare(b.path));
  for(const file of migrationFiles) {
    if(file.error){warnings.push({file:file.path,line:file.line||1,message:file.error});continue;}
    const before=warnings.length;let ops=0;
    for(const mod of moduleNodes(file.ast)) {
      const ctx=moduleContext(file,mod),defs=block(body(mod)).filter(n=>call(n)==='def');
      const forward=defs.find(n=>call(args(n)[0])==='change')||defs.find(n=>call(args(n)[0])==='up');
      if(forward)for(const n of block(body(forward))){migrationCommand(n,ctx);ops++;}
      else warn(ctx,mod,'No static change/0 or up/0 migration function was found.');
    }
    migrations.push({file:file.path,version:pathVersion(file.path),operations:ops,warnings:warnings.length-before});
  }
  // Read schemas after migration replay. Database columns remain authoritative where available.
  for(const file of parsed.filter(f=>f.kind==='schema')) {
    if(file.error){warnings.push({file:file.path,line:file.line||1,message:file.error});continue;}
    for(const mod of moduleNodes(file.ast)) {
      const ctx=moduleContext(file,mod);
      for(const schema of block(body(mod)).filter(n=>call(n)==='schema')) {
        const name=text(literal(args(schema)[0],ctx.env)),prefix=text(ctx.env.schema_prefix)||'public';
        if(droppedTables.has(tableID(name,prefix))){warn(ctx,schema,'Schema references a dropped or renamed table; the stale declaration is omitted.');continue;}
        const t=ensure(name,prefix,ctx,schema,'schema');if(!t)continue;modules.set(ctx.module,t.id);t.schemaModules.push(ctx.module);
        const schemaOnly=t.origin==='schema';
        if(schemaOnly&&ctx.env.primary_key!==false){const pk=Array.isArray(ctx.env.primary_key)?ctx.env.primary_key:['id','id'];t.columns.push({name:pk[0],type:sqlType(pk[1]),ectoType:pk[1],nullable:false,primaryKey:true,default:null,options:{},origin:'schema',source:source(ctx,schema),reference:null});}
        for(const n of block(body(schema))) {
          const kind=call(n),a=args(n),o=optValues(a.at(-1),ctx.env),fieldName=text(literal(a[0],ctx.env));
          if(kind==='field'&&o.virtual!==true) {
            const dbName=o.source||fieldName,existing=t.columns.find(c=>c.name===dbName);
            if(removedColumns.get(t.id)?.has(dbName)){warn(ctx,n,`Schema field ${dbName} references a removed or renamed column; the stale declaration is omitted.`);continue;}
            if(existing){existing.ectoType=typeName(a[1]);existing.schemaField=fieldName;existing.schemaOptions=o;}
            else {
              t.columns.push({name:dbName,type:sqlType(typeName(a[1])),ectoType:typeName(a[1]),nullable:null,primaryKey:o.primary_key||false,default:o.default??null,options:o,origin:'schema',source:source(ctx,n),reference:null});
              if(!schemaOnly)warn(ctx,n,`Schema field ${dbName} has no resolved migration column; database presence is unverified.`);
            }
          } else if(['belongs_to','has_many','has_one','many_to_many'].includes(kind)) {
            const target=literal(a[1],ctx.env);const assoc={name:fieldName,kind,targetModule:typeof target==='string'?target:null,foreignKey:o.foreign_key||(kind==='belongs_to'?`${fieldName}_id`:null),references:o.references||'id',options:o,source:source(ctx,n)};
            t.associations.push(assoc);
            if(kind==='belongs_to'&&o.define_field!==false&&!t.columns.some(c=>c.name===assoc.foreignKey))t.columns.push({name:assoc.foreignKey,type:sqlType(o.type||ctx.env.foreign_key_type||'id'),ectoType:o.type||ctx.env.foreign_key_type||'id',nullable:null,primaryKey:o.primary_key||false,default:null,options:o,origin:'schema',source:source(ctx,n),reference:null});
          } else if(kind==='timestamps'&&schemaOnly) {
            for(const key of ['inserted_at','updated_at'])if(o[key]!==false)t.columns.push({name:o[key]||key,type:sqlType(o.type||'naive_datetime'),ectoType:o.type||'naive_datetime',nullable:null,primaryKey:false,default:null,options:{},origin:'schema',source:source(ctx,n),reference:null});
          } else if(['embeds_one','embeds_many'].includes(kind))t.associations.push({name:fieldName,kind,targetModule:literal(a[1],ctx.env),options:o,source:source(ctx,n)});
        }
        t.primaryKey=t.columns.filter(c=>c.primaryKey).map(c=>c.name);
      }
    }
  }
  for(const t of tables.values())if(t.partitionOf&&tables.has(t.partitionOf)&&!t.columns.length){t.columns=structuredClone(tables.get(t.partitionOf).columns);t.primaryKey=[...tables.get(t.partitionOf).primaryKey];}
  const relationships=[];
  for(const t of tables.values()) {
    for(const a of t.associations) a.targetTable=modules.get(a.targetModule)||null;
    for(const c of t.columns)if(c.reference){const r=c.reference;relationships.push({id:`${t.id}.${c.name}`,from:t.id,to:r.table,column:c.name,targetColumn:r.column,kind:'foreign_key',nullable:c.nullable,onDelete:r.onDelete,onUpdate:r.onUpdate,resolved:tables.has(r.table),source:c.source});}
    for(const a of t.associations)if(a.kind==='belongs_to'&&a.targetTable&&!relationships.some(r=>r.from===t.id&&r.column===a.foreignKey))relationships.push({id:`${t.id}.${a.foreignKey}.association`,from:t.id,to:a.targetTable,column:a.foreignKey,targetColumn:a.references,kind:'association',resolved:true,source:a.source});
  }
  return {formatVersion:1,capabilities:{provider:'ecto-repository',query:false,refresh:true},tables:[...tables.values()].sort((a,b)=>a.id.localeCompare(b.id)),relationships,warnings,migrations,coverage:{mode:'static',note:'Repository declarations only. Migration application state, runtime-generated DDL, database sizes and row counts require a live database.',migrationDefaults:'Conventional Ecto defaults are assumed where no explicit option is present. Custom Repo migration defaults require verification.'}};
}
function pathVersion(p){return p.split('/').at(-1).split('_')[0];}
// SQL delimiter splitting respects quoted strings, parentheses and dollar bodies.
export function splitSQL(s,delimiter) {
  const parts=[];let start=0,depth=0,quote=null,dollar=null;
  for(let i=0;i<s.length;i++) {
    const ch=s[i];
    if(dollar){if(s.startsWith(dollar,i)){i+=dollar.length-1;dollar=null;}continue;}
    if(quote){if(ch===quote){if(s[i+1]===quote)i++;else quote=null;}continue;}
    if(ch==='"'||ch==="'"){quote=ch;continue;}
    if(ch==='$'){const m=s.slice(i).match(/^\$[\w]*\$/);if(m){dollar=m[0];i+=dollar.length-1;continue;}}
    if(ch==='(')depth++;else if(ch===')')depth--;
    if(ch===delimiter&&depth===0){parts.push(s.slice(start,i));start=i+1;}
  }parts.push(s.slice(start));return parts;
}
function findClosing(s,start){let depth=0,quote=null;for(let i=start;i<s.length;i++){const c=s[i];if(quote){if(c===quote){if(s[i+1]===quote)i++;else quote=null;}continue;}if(c==="'"||c==='"')quote=c;else if(c==='(')depth++;else if(c===')'&&--depth===0)return i;}return -1;}

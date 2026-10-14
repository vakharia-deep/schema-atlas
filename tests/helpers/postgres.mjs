import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import pg from 'pg';

const run=promisify(execFile);
export async function postgresTools(){
  const {stdout}=await run('pg_config',['--bindir'],{timeout:5000});return stdout.trim();
}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
export async function fixture({profiling=false}={}){
  const bin=await postgresTools(),root=await mkdtemp(path.join(tmpdir(),'atlas-pg-'));await chmod(root,0o700);
  const data=path.join(root,'data'),pwfile=path.join(root,'init-password'),cert=path.join(root,'server.crt'),key=path.join(root,'server.key');
  const adminPassword=randomBytes(32).toString('base64url'),password=randomBytes(32).toString('base64url'),port=await freePort();let started=false,admin;
  const cleanup=async()=>{if(admin)await admin.end().catch(()=>{});if(started)await run(path.join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{timeout:15000});await rm(root,{recursive:true,force:true});};
  try{
    await writeFile(pwfile,adminPassword,{mode:0o600});
    await run(path.join(bin,'initdb'),['-D',data,'-U','atlas_admin','--auth=scram-sha-256','--pwfile',pwfile,'--no-locale','--encoding=UTF8'],{timeout:30000});await rm(pwfile);
    await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{timeout:15000});await chmod(key,0o600);
    await writeFile(path.join(data,'postgresql.auto.conf'),`listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories='${root.replaceAll("'","''")}'\nssl=on\nssl_cert_file='${cert.replaceAll("'","''")}'\nssl_key_file='${key.replaceAll("'","''")}'\n`+(profiling?"shared_preload_libraries='pg_stat_statements'\nlogging_collector=on\nlog_destination='stderr,jsonlog'\nsession_preload_libraries='auto_explain'\nauto_explain.log_min_duration=0\nauto_explain.log_format='json'\nauto_explain.log_analyze=on\nauto_explain.log_buffers=on\nauto_explain.log_timing=off\nauto_explain.log_parameter_max_length=0\n":''),{mode:0o600});
    await run(path.join(bin,'pg_ctl'),['-D',data,'-l',path.join(root,'postgres.log'),'-w','start'],{timeout:15000});started=true;
    admin=new pg.Client({host:'127.0.0.1',port,user:'atlas_admin',database:'postgres',password:adminPassword});await admin.connect();if(profiling)await admin.query('CREATE EXTENSION pg_stat_statements');
    await admin.query("SELECT set_config('atlas.fixture_password',$1,false)",[password]);
    await admin.query(`DO $$ BEGIN EXECUTE format('CREATE ROLE atlas_reader LOGIN PASSWORD %L',current_setting('atlas.fixture_password')); END $$;
      CREATE SCHEMA core; CREATE SCHEMA audit;
      CREATE TYPE core.status AS ENUM ('active','paused');
      CREATE TABLE core.accounts (tenant_id integer, id integer, email text NOT NULL, status core.status DEFAULT 'active', tags text[], settings jsonb DEFAULT '{}', normalized_email text GENERATED ALWAYS AS (lower(email)) STORED, PRIMARY KEY(tenant_id,id), UNIQUE(email), CHECK(length(email)>2));
      COMMENT ON TABLE core.accounts IS 'Customer accounts';
      COMMENT ON COLUMN core.accounts.email IS 'Primary contact address';
      CREATE INDEX accounts_search ON core.accounts USING gin(settings);
      CREATE INDEX accounts_active ON core.accounts (lower(email)) INCLUDE(status) WHERE status='active';
      CREATE TABLE core.projects (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id integer NOT NULL, account_id integer NOT NULL, name text, FOREIGN KEY(tenant_id,account_id) REFERENCES core.accounts(tenant_id,id) ON UPDATE CASCADE ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
      CREATE TABLE core.profiles (tenant_id integer, account_id integer, UNIQUE(tenant_id,account_id), FOREIGN KEY(tenant_id,account_id) REFERENCES core.accounts(tenant_id,id));
      CREATE TABLE audit.events (id bigint, occurred_on date NOT NULL, payload jsonb, PRIMARY KEY(id,occurred_on)) PARTITION BY RANGE(occurred_on);
      CREATE TABLE audit.events_2026 PARTITION OF audit.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
      CREATE TABLE audit.events_default PARTITION OF audit.events DEFAULT;
      CREATE TABLE core.reservations (during tsrange, EXCLUDE USING gist(during WITH &&));
      CREATE TABLE core."odd.table" ("odd.column" integer PRIMARY KEY);
      CREATE TABLE core.quoted_ref (id integer REFERENCES core."odd.table"("odd.column"));
      CREATE VIEW core.account_names AS SELECT id,email FROM core.accounts;
      CREATE MATERIALIZED VIEW core.account_summary AS SELECT count(*) AS total FROM core.accounts;
      CREATE FUNCTION core.touch_project() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
      CREATE TRIGGER project_touch BEFORE UPDATE ON core.projects FOR EACH ROW EXECUTE FUNCTION core.touch_project();
      ALTER TABLE core.projects ENABLE ROW LEVEL SECURITY;
      CREATE POLICY project_visibility ON core.projects FOR SELECT TO atlas_reader USING (tenant_id=1);
      GRANT USAGE ON SCHEMA core,audit TO atlas_reader;
      GRANT CONNECT ON DATABASE postgres TO atlas_reader;`);
    const config={name:'PostgreSQL verification',host:'127.0.0.1',port,database:'postgres',user:'atlas_reader',password,tls:'local',ca:''};
    return {root,admin,config,adminConfig:{...config,user:'atlas_admin',password:adminPassword},ca:await readFile(cert,'utf8'),cleanup};
  }catch(error){await cleanup();throw error;}
}

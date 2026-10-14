// Disposable local PostgreSQL fixture for manual browser verification.
import { fixture } from './postgres.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
const f=await fixture();
const configFile=path.join(f.root,'browser-connection.json');
await writeFile(configFile,JSON.stringify(f.config),{mode:0o600});
console.log(`Disposable browser fixture: ${configFile}`);
const input=createInterface({input:process.stdin});
input.on('line',async line=>{
  if(line==='mutate'){await f.admin.query('ALTER TABLE core.projects ADD COLUMN archived_at timestamptz; CREATE TABLE core.browser_added(id integer PRIMARY KEY, project_id bigint REFERENCES core.projects(id));');console.log('Added test table and column.');}
  if(line==='large'){
    await f.admin.query(`DO $$ BEGIN FOR i IN 1..80 LOOP
      EXECUTE format('CREATE TABLE core.%I (id bigint PRIMARY KEY, project_id bigint REFERENCES core.projects(id), name text NOT NULL, created_at timestamptz, updated_at timestamptz, status text, settings jsonb, archived_at timestamptz)', 'catalog_' || lpad(i::text,3,'0'));
    END LOOP; END $$;
    CREATE TABLE audit.sharded(id bigint) PARTITION BY HASH(id);
    CREATE TABLE audit.sharded_0 PARTITION OF audit.sharded FOR VALUES WITH (MODULUS 2, REMAINDER 0);
    CREATE TABLE audit.regions(region text, occurred_on date) PARTITION BY LIST(region);
    CREATE TABLE audit.regions_us PARTITION OF audit.regions FOR VALUES IN ('US') PARTITION BY RANGE(occurred_on);
    CREATE TABLE audit.regions_us_2026 PARTITION OF audit.regions_us FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');`);
    console.log('Large-schema fixture ready (96 objects, range/list/hash and nested partitions).');
  }
  if(line==='stop'){await f.cleanup();input.close();process.exit(0);}
});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await f.cleanup();process.exit(0);});

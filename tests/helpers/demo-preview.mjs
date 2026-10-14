// Isolated, synthetic shop database for documentation captures. Never uses saved connections.
import pg from 'pg';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fixture } from './postgres.mjs';
import { createApp } from '../../server.mjs';
import { ProfileStore, credentialEntry } from '../../lib/profiles.mjs';

const f = await fixture({ profiling: true });
const profileDirectory = path.join(f.root, 'demo-profiles');
let admin, server, input, stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  input?.close();
  if (server?.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  if (admin) await admin.end().catch(() => {});
  // Only the isolated demo store's key is addressed; the user's real profiles are untouched.
  await credentialEntry(profileDirectory).deleteCredential().catch(() => {});
  await f.cleanup();
}
try {
  await f.admin.query('CREATE DATABASE atlas_demo');
  const config = { ...f.adminConfig, database: 'atlas_demo', name: 'Demo store' };
  admin = new pg.Client({ ...config, application_name: 'schema-atlas-demo-setup' });
  await admin.connect();
  await admin.query(`CREATE EXTENSION pg_stat_statements;
    CREATE SCHEMA shop;
    CREATE TABLE shop.customers (id integer PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, joined_at date NOT NULL);
    CREATE TABLE shop.products (id integer PRIMARY KEY, sku text NOT NULL, name text NOT NULL, price numeric(10,2) NOT NULL, inventory integer NOT NULL);
    CREATE TABLE shop.orders (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES shop.customers(id), status text NOT NULL, total numeric(10,2) NOT NULL, placed_at timestamp NOT NULL, shipping jsonb NOT NULL);
    CREATE INDEX orders_customer_idx ON shop.orders(customer_id);
    CREATE INDEX orders_pending_idx ON shop.orders(placed_at) WHERE status = 'pending';
    CREATE TABLE shop.order_items (order_id integer REFERENCES shop.orders(id), product_id integer REFERENCES shop.products(id), quantity integer NOT NULL, unit_price numeric(10,2) NOT NULL, PRIMARY KEY(order_id,product_id));
    CREATE TABLE shop.payments (id integer PRIMARY KEY, order_id integer NOT NULL REFERENCES shop.orders(id), method text NOT NULL, amount numeric(10,2) NOT NULL);
    CREATE TABLE shop.shipments (id integer PRIMARY KEY, order_id integer NOT NULL UNIQUE REFERENCES shop.orders(id), status text NOT NULL, dispatched_at timestamp);
    CREATE TABLE shop.events (id bigint, order_id integer REFERENCES shop.orders(id), occurred_on date NOT NULL, event_type text NOT NULL, PRIMARY KEY(id,occurred_on)) PARTITION BY RANGE(occurred_on);
    CREATE TABLE shop.events_2026_01 PARTITION OF shop.events FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
    CREATE TABLE shop.events_2026_02 PARTITION OF shop.events FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
    COMMENT ON TABLE shop.orders IS 'Fictional orders used only for product demonstrations.';
    COMMENT ON TABLE shop.events IS 'Order activity, partitioned by month.';
    INSERT INTO shop.customers SELECT n, 'Sample customer ' || n, 'customer' || n || '@example.com', DATE '2026-01-01' + (n % 25) FROM generate_series(1,250) n;
    INSERT INTO shop.products SELECT n, 'SKU-' || n, 'Sample product ' || n, (n % 200) + 9.95, 20 + (n % 80) FROM generate_series(1,50000) n;
    INSERT INTO shop.orders SELECT n, (n % 250) + 1, CASE WHEN n % 3 = 0 THEN 'pending' ELSE 'shipped' END, (n % 150) + 29.95, TIMESTAMP '2026-01-01 09:00' + n * INTERVAL '5 minutes', jsonb_build_object('city','Sample City','delivery','standard','note','Fictional demo address') FROM generate_series(1,20000) n;
    INSERT INTO shop.order_items SELECT n, (n % 50000) + 1, 1, 29.95 FROM generate_series(1,20000) n;
    INSERT INTO shop.payments SELECT n, n, 'demo payment', (n % 150) + 29.95 FROM generate_series(1,1000) n;
    INSERT INTO shop.shipments SELECT n, n, 'dispatched', TIMESTAMP '2026-01-02 09:00' FROM generate_series(1,500) n;
    INSERT INTO shop.events SELECT n, n, DATE '2026-01-01' + (n % 28), 'order_created' FROM generate_series(1,1000) n;
    ANALYZE;`);
  const configFile = path.join(f.root, 'browser-connection.json');
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  server = createApp([], { profileStore: new ProfileStore(profileDirectory) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8791, '127.0.0.1', resolve); });
  console.log('Demo: http://127.0.0.1:8791/');
  console.log('Temporary connection details: ' + configFile);
  console.log('Commands: add-index, workload, mutate, stop');
  input = createInterface({ input: process.stdin });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); });
  for await (const line of input) {
    if (stopping) break;
    try {
      if (line === 'add-index') {
        await admin.query('CREATE INDEX IF NOT EXISTS products_sku_idx ON shop.products(sku); ANALYZE shop.products');
        console.log('Created products_sku_idx in the disposable database.');
      } else if (line === 'workload') {
        const client = new pg.Client({ ...config, application_name: 'demo-storefront' });
        try {
          await client.connect();
          for (let i = 0; i < 5; i++) await client.query('SELECT id, sku, name, price FROM shop.products WHERE sku = $1', ['SKU-42000']);
          for (let i = 0; i < 3; i++) await client.query('SELECT id, status, total FROM shop.orders WHERE customer_id = $1', [42]);
        } finally { await client.end(); }
        console.log('Completed eight synthetic storefront queries.');
      } else if (line === 'mutate') {
        await admin.query('ALTER TABLE shop.orders ADD COLUMN IF NOT EXISTS delivered_at timestamp');
        console.log('Added orders.delivered_at in the disposable database.');
      } else if (line === 'stop') break;
      else console.log('Use add-index, workload, mutate, or stop.');
    } catch { console.error('Demo operation failed; database details were omitted.'); }
  }
} finally { await stop(); }

# Product walkthroughs

These GIFs show the real Schema Atlas UI connected to a disposable PostgreSQL database. All table contents are generated fictional shop data. The clips use selected browser frames with step captions and shortened pauses; they are not continuous screen recordings. Results and query plans were produced by PostgreSQL, not mocked. Captured on 2026-10-14 with PostgreSQL 16.15.

| Walkthrough | Animation | Static alternative | Length |
| --- | --- | --- | --- |
| Relationships, indexes and partitions | [GIF](schema-explorer.gif) | [PNG](schema-explorer.png) | 18 s |
| SQL completion and whole-row details | [GIF](sql-workspace.gif) | [PNG](sql-workspace.png) | 15.4 s |
| Before/after index comparison | [GIF](index-comparison.gif) | [PNG](index-comparison.png) | 18 s |
| Application-query capture | [GIF](application-capture.gif) | [PNG](application-capture.png) | 19 s |

The images are 1280 × 824, including the caption strip. Each GIF is under 1 MB; all four total about 2.7 MB. Open an image directly to view it at full size. The text instructions below provide an alternative to animation.

## Start the same demo database

Run from the repository root as a normal OS user. This helper requires Node.js 22+, installed npm dependencies, OpenSSL, and `pg_config` pointing to a PostgreSQL **16+** server installation with `pg_stat_statements` and `auto_explain`. The capture fixture uses a PostgreSQL 16 setting. Port 8791 must be free. The demo was verified on macOS; it has not been verified on Windows or Linux.

```sh
npm ci
node tests/helpers/demo-preview.mjs
```

The helper starts a separate temporary PostgreSQL cluster on a dynamically selected loopback port and the application at [http://127.0.0.1:8791/](http://127.0.0.1:8791/). It does not change or restart your existing PostgreSQL server. Profiling is enabled only in this disposable cluster.

1. Keep the helper running in its terminal. It prints the path to a private temporary `browser-connection.json` file; open that file locally to obtain the generated connection details.
2. Open the demo URL and click **Connect PostgreSQL**.
3. Enter the file's `host`, `port`, `database`, `user`, and `password` values. Use **Demo store** as the connection name and **Localhost / SSH tunnel · No TLS** as the security mode.
4. Uncheck **Save this connection and password**, then connect. The demo database is `atlas_demo`; the synthetic tables are in schema `shop`.
5. After exploring, enter `stop` in the helper's terminal or press **Ctrl+C**. Normal shutdown removes the temporary database, connection file and isolated demo profile storage/key.

The generated database role is an administrator of this disposable cluster so the capture demo can read its PostgreSQL logs. It is not a recommended role for a normal application connection. Demo profile storage is isolated from your usual saved connections. Do not record the connection form, copy the temporary password into documentation, or commit the private connection file.

If the process is forcibly killed, normal cleanup cannot run. Remove only the temporary cluster printed by that run after stopping it; do not point cleanup commands at an existing PostgreSQL data directory.

### Terminal commands

Type these into the **running helper's terminal**, not the SQL workspace or a new shell:

| Command | Effect in the disposable database |
| --- | --- |
| `add-index` | Creates `shop.products_sku_idx` on `shop.products(sku)` and refreshes PostgreSQL statistics. |
| `workload` | Opens an application connection named `demo-storefront`, runs five product lookups and three customer-order lookups, then closes it. |
| `mutate` | Adds `shop.orders.delivered_at` so schema-refresh changes can be explored. |
| `stop` | Shuts down the demo application and removes its temporary cluster and private files. |

The shop includes 50,000 products, 20,000 orders, related customers/items/payments/shipments, and an events table with two monthly partitions. Restart the helper for a fresh database if you want to repeat the before/after index demo from its original baseline.

## 1. Explore relationships and metadata

1. Open **Schema explorer**, filter the ER diagram to `shop`, and select **Full screen**. Scroll or pan at 100% to keep table names readable.
2. Switch to **Relationship explorer** and select `shop.orders`. **References** shows its customer relation; **Referenced by** shows the tables with foreign keys pointing to orders.
3. Click `shop.customers` to follow that relation, then use **Back** to return.
4. Click **Inspect metadata → Indexes**. Inspect `orders_customer_idx`; expand **SQL definition** to read its definition.
5. Select `shop.events` and inspect **Details**. It is partitioned by `RANGE (occurred_on)`.
6. Scroll to **Partitions** to see the January and February child tables and their exact range bounds.

[Watch](schema-explorer.gif) · [Static image](schema-explorer.png) · [Full guide](../../README.md#use-the-schema-explorer)

## 2. Complete SQL and open a whole row

1. Open **SQL workspace** and select **Full screen**.
2. Type `SELECT *` followed by `FROM shop.or`. Use the automatic table suggestions or **Ctrl+Space**.
3. Select `shop.orders` with the arrow keys, then press **Tab** to insert the quoted table name.
4. Complete the query and select **Run query**:

```sql
SELECT *
FROM "shop"."orders"
WHERE status = 'pending'
ORDER BY placed_at DESC
LIMIT 5;
```

5. Click a result cell to open that **entire row**. Scroll the modal to read all columns, including the synthetic `shipping` JSON.

[Watch](sql-workspace.gif) · [Static image](sql-workspace.png) · [Full guide](../../README.md#use-the-sql-workspace)

## 3. Compare index usage before and after

Use a fresh demo database before issuing `add-index`.

1. Open **Query profiling → Plan inspector** and enter:

```sql
SELECT id, sku, name, price
FROM shop.products
WHERE sku = $1;
```

2. Set **Parameter values** to `["SKU-42000"]`, select **Run & profile**, and **Save as baseline**. The recorded baseline used a `Seq Scan` on products.
3. Enter `add-index` in the helper's terminal. This performs the schema change externally; Schema Atlas's SQL workspace remains read-only.
4. Click **Refresh schema**, return to the Plan inspector, and run the same SQL with the same parameters again.
5. Inspect the executed node and table/index context. The recorded second run used an `Index Scan` through `products_sku_idx`.
6. Open **Compare**. Read execution time and buffer counts alongside the two scan strategies and index names.

Timings depend on hardware, cache state, data distribution, statistics and concurrent activity. This example demonstrates plan evidence, not a guaranteed speedup or a recommendation to add an index to every sequential scan. No extension is needed for this manual comparison.

[Watch](index-comparison.gif) · [Static image](index-comparison.png) · [Full guide](../../README.md#compare-before-and-after)

## 4. Capture application queries

Run `add-index` first if you want to match the recorded plan.

1. Open **Query profiling → Setup** and run **Check setup**. Manual EXPLAIN, query patterns and application plans should show ready for the demo fixture.
2. Open **Capture** and select **Start profiling**.
3. Enter `workload` in the helper's terminal. Its separate `demo-storefront` connection acts as the sample application.
4. After the terminal reports completion, select **Stop profiling**. The recording contains two normalized query patterns: five product lookups and three order lookups, with eight application plans.
5. Scroll to **Captured application plans** and choose a product lookup using **View captured plan**.
6. Check the **Captured application execution** source label. Opening this plan does not execute its SQL again. Inspect the `Index Scan` node, its actual loop count, and `products_sku_idx` in the table/index context.

Query-pattern statistics require `pg_stat_statements`. Recorded application plans require `auto_explain`, PostgreSQL JSON logging and log-reading privileges; measured index evidence also requires `auto_explain.log_analyze`. The fixture supplies these. For a normal database, use the [setup instructions](../../README.md#configure-postgresql-profiling) and [feature dependency table](../../README.md#feature-dependencies-and-what-stops-working).

[Watch](application-capture.gif) · [Static image](application-capture.png) · [Full guide](../../README.md#capture-an-application-workflow)

## Updating the media

Record the running demo UI at 1280 × 720 using only its fictional data. Exclude browser chrome, connection forms, saved profiles and unrelated applications. Review every frame before publishing. Raw captures and rendering scratch files belong in the ignored `artifacts/` directory; only the reviewed GIFs and static PNGs belong here.

These clips were assembled from browser captures with a 104-pixel caption strip, encoded with a shared GIF palette at 5 fps, looped, and stripped of source metadata. No additional runtime dependency was added to Schema Atlas. All GIF frames were decoded successfully and reviewed against the captured states; the helper's index, workload, schema-change and cleanup commands were exercised with the isolated database. On 2026-10-14, `ATLAS_TEST_KEYCHAIN=1 npm test` passed all 58 tests with no skips, including the native credential-store check. Documentation links and anchors were also checked.

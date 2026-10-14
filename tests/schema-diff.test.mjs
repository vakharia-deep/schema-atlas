import test from 'node:test';
import assert from 'node:assert/strict';
import { diffModels } from '../lib/schema-diff.mjs';

test('first catalog snapshot is a baseline, not added tables', () => {
  assert.deepEqual(diffModels(null, { tables: [{ id: 'public.first', columns: [] }] }), {
    baseline: true, added: [], removed: [], changed: [], total: 0
  });
});

test('snapshot diff finds added and removed tables, columns, indexes and partitions', () => {
  const a = { tables: [{ id: 'public.a', columns: [{ name: 'id' }, { name: 'old' }], indexes: [], partitions: [] }, { id: 'public.removed', columns: [] }] };
  const b = { tables: [{ id: 'public.a', columns: [{ name: 'id' }, { name: 'new' }], indexes: [{ name: 'idx' }], partitions: [{ name: 'p' }] }, { id: 'public.added', columns: [] }] };
  const d = diffModels(a, b);
  assert.equal(d.total, 3);
  assert.deepEqual(d.added, ['public.added']);
  assert.deepEqual(d.removed, ['public.removed']);
  assert.deepEqual(d.changed[0].details, ['columns', 'indexes', 'partitions']);
  assert.deepEqual(d.changed[0].addedColumns, ['new']);
  assert.deepEqual(d.changed[0].removedColumns, ['old']);
});

test('statistics changes do not mask real catalog definition changes', () => {
  const a = { tables: [{ id: 'public.a', columns: [{ name: 'id', default: null }], indexes: [{ name: 'idx', statistics: { bytes: 1024 } }], statistics: { estimatedRows: 10 } }] };
  const b = structuredClone(a);
  b.tables[0].indexes[0].statistics.bytes = 2048;
  b.tables[0].statistics.estimatedRows = 20;
  assert.equal(diffModels(a, b).total, 0);
  b.tables[0].columns[0].default = '1';
  assert.deepEqual(diffModels(a, b).changed[0].details, ['columns']);
});

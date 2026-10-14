// Compare catalog metadata, ignoring volatile statistics and source annotations.
export function diffModels(previous, next) {
  if (!previous) return { baseline: true, added: [], removed: [], changed: [], total: 0 };
  const before = new Map(previous.tables.map(t => [t.id, t]));
  const after = new Map(next.tables.map(t => [t.id, t]));
  const added = [...after.keys()].filter(k => !before.has(k));
  const removed = [...before.keys()].filter(k => !after.has(k));
  const changed = [];
  for (const [id, table] of after) {
    if (!before.has(id)) continue;
    const old = before.get(id), details = [];
    for (const field of ['columns', 'indexes', 'constraints', 'partitions', 'options', 'primaryKey', 'comment', 'kind', 'partitionOf', 'viewDefinition', 'triggers', 'policies', 'grants']) {
      const metadata = value => JSON.stringify(value, (key, item) => key === 'source' || key === 'statistics' ? undefined : item);
      if (metadata(old[field]) !== metadata(table[field])) details.push(field);
    }
    if (details.length) {
      const cols = new Map(old.columns.map(c => [c.name, c]));
      changed.push({ id, details, addedColumns: table.columns.filter(c => !cols.has(c.name)).map(c => c.name), removedColumns: old.columns.filter(c => !table.columns.some(n => n.name === c.name)).map(c => c.name) });
    }
  }
  return { baseline: false, added, removed, changed, total: added.length + removed.length + changed.length };
}

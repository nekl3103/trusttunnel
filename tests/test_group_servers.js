const assert = require('node:assert/strict');
const fs = require('node:fs');
const rows = {};
const uci = {
  sections(config, type, callback) {
    const result = Object.values(rows).filter(row => row['.type'] === type);
    if (callback) result.forEach(callback);
    return result;
  },
  set(config, id, field, value) { rows[id][field] = value; },
  unset(config, id, field) { delete rows[id][field]; }
};
function E(tag, attrs = {}, children = []) {
  return { tag, ...attrs, children, appendChild(child) { this.children.push(child); }, querySelectorAll() { return []; } };
}
const view = new Function('view', 'uci', 'rpc', 'L', 'E',
  fs.readFileSync('packages/luci-app-trusttunnel/htdocs/luci-static/resources/view/trusttunnel/settings.js', 'utf8'))(
  { extend: value => value }, uci, { declare: () => () => Promise.resolve({}) },
  { toArray: value => Array.isArray(value) ? value : value ? [value] : [] }, E);
function server(id) { rows[id] = { '.name': id, '.type': 'server' }; }
function group(id, fields) { rows[id] = { '.name': id, '.type': 'group', ...fields }; }
server('keep'); server('new');
view.serverIds = ['keep', 'deleted'];
group('manual', { strategy: 'manual', server: 'deleted', pool: ['deleted'], primary: 'deleted' });
group('custom', { strategy: 'priority', primary: 'keep', pool: ['keep', 'deleted'], enabled: '0' });
group('implicit', { strategy: 'auto' });
group('pinned', { strategy: 'manual', server: 'keep' });
const stale = { value: 'deleted', parentNode: { remove() { stale.removed = true; } } };
const pool = E('div');
pool.querySelectorAll = () => stale.removed ? [] : [stale];
view.geositeControls = [{ route: E('select', { value: 'fixed:deleted' }),
  primary: E('select', { value: 'deleted' }), pool }];
// Exercise reconciliation around the existing form collector without mocking its effects on UCI.
view.collectGeositeGroups = function() {
  assert.equal(this.geositeControls[0].route.value, 'auto');
  assert.equal(this.geositeControls[0].primary.value, '');
  assert.equal(stale.removed, true);
};
view.syncGroupServers();
assert.equal(rows.manual.strategy, 'auto');
assert.equal(rows.manual.server, undefined);
assert.equal(rows.manual.primary, undefined);
assert.deepEqual(rows.manual.pool, ['new']);
assert.deepEqual(rows.custom.pool, ['keep', 'new']);
assert.equal(rows.custom.primary, 'keep');
assert.deepEqual(rows.implicit.pool, ['keep', 'new']);
assert.equal(rows.pinned.server, 'keep');
assert.deepEqual(rows.pinned.pool, ['keep', 'new']);
assert.equal(pool.children.length, 1);
assert.equal(pool.children[0].children[0].checked, true);
view.syncGroupServers();
assert.equal(pool.children.length, 1, 'repeated save must not duplicate newly added servers');
assert.deepEqual(rows.custom.pool, ['keep', 'new']);
delete rows.new;
view.geositeControls = [];
view.collectGeositeGroups = () => {};
view.syncGroupServers();
assert.deepEqual(rows.custom.pool, ['keep']);
assert.equal(rows.manual.pool, '');
console.log('PASS: group server deletion, addition, pinning, implicit pools, disabled groups and repeated save');

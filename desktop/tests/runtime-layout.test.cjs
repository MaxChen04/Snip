const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareRuntimeLayout, resolveRuntimeLayout } = require('../runtime-layout.cjs');

test('source Snip Dev and packaged nightlies share only their isolated test library', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-channels-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'source');
  fs.mkdirSync(root);
  const stable = prepareRuntimeLayout({ root, userData: path.join(temp, 'Snip'), release: false });
  const options = { root, userData: path.join(temp, 'Snip Dev'), resourcesPath: path.join(temp, 'Snip Dev.app/Contents/Resources'), isolated: true, port: 5273 };
  fs.mkdirSync(options.resourcesPath, { recursive: true });
  const source = prepareRuntimeLayout({ ...options, release: false, recordSource: true });
  const packaged = prepareRuntimeLayout({ ...options, release: true });
  assert.equal(stable.dataRoot, root);
  assert.equal(source.runtimeRoot, root);
  assert.equal(source.dataRoot, path.join(options.userData, 'library'));
  assert.equal(packaged.dataRoot, source.dataRoot);
  assert.match(fs.readFileSync(source.webEnvPath, 'utf8'), /PUBLIC_URL=http:\/\/localhost:5273/);
  assert.equal(fs.existsSync(path.join(root, 'web')), false);
  fs.writeFileSync(source.pointerPath, JSON.stringify({ path: root }));
  assert.throws(() => prepareRuntimeLayout({ ...options, release: true }), { code: 'SNIP_LIBRARY_LOCATION' });
  assert.throws(() => require('../runtime-layout.cjs').selectExistingLibrary({ ...options, release: true }, root), /test library/);
});

test('a symlink cannot redirect the test library outside its profile', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-channels-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const userData = path.join(temp, 'Snip Dev'), outside = path.join(temp, 'stable');
  fs.mkdirSync(userData); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(userData, 'library'));
  assert.throws(() => prepareRuntimeLayout({ root: temp, userData, release: false, isolated: true, port: 5273 }), /test library/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('source setup records the library and a release reuses it without changing it', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-layout-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'source');
  const userData = path.join(temp, 'profile');
  const resourcesPath = path.join(temp, 'Snip.app/Contents/Resources');
  fs.mkdirSync(root);
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.mkdirSync(path.join(root, 'web/.wrangler/state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'capture'));
  fs.writeFileSync(path.join(root, 'web/.dev.vars'), 'existing');
  fs.writeFileSync(path.join(root, 'capture/.env'), 'existing');
  fs.writeFileSync(path.join(root, 'canary'), 'existing library');
  const source = prepareRuntimeLayout({ root, userData, resourcesPath, release: false, recordSource: true });
  const release = prepareRuntimeLayout({ root, userData, resourcesPath, release: true, port: 5173 });
  assert.equal(source.dataRoot, root);
  assert.equal(release.dataRoot, root);
  assert.equal(release.runtimeRoot, path.join(resourcesPath, 'runtime'));
  assert.equal(fs.readFileSync(path.join(root, 'canary'), 'utf8'), 'existing library');
  assert.equal(fs.readFileSync(release.webEnvPath, 'utf8'), 'existing');
});

test('fresh release initializes private matching credentials once', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-layout-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const options = { userData: path.join(temp, 'profile'), resourcesPath: path.join(temp, 'Snip.app/Contents/Resources'), release: true, port: 5173 };
  fs.mkdirSync(options.resourcesPath, { recursive: true });
  const layout = prepareRuntimeLayout(options);
  const web = fs.readFileSync(layout.webEnvPath, 'utf8');
  const capture = fs.readFileSync(layout.captureEnvPath, 'utf8');
  const token = web.match(/^CAPTURE_TOKEN=(.+)$/m)[1];
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.match(web, /^SESSION_SECRET=[a-f0-9]{64}$/m);
  assert.ok(capture.includes(`CAPTURE_TOKEN=${token}\n`));
  assert.ok(capture.includes('SNIP_URL=http://localhost:5173\n'));
  assert.equal(fs.statSync(layout.webEnvPath).mode & 0o777, 0o600);
  prepareRuntimeLayout(options);
  assert.equal(fs.readFileSync(layout.webEnvPath, 'utf8'), web);
});

test('invalid, missing, and in-app saved libraries do not silently create a new library', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-layout-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const userData = path.join(temp, 'profile');
  const resourcesPath = path.join(temp, 'Snip.app/Contents/Resources');
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.mkdirSync(userData);
  const pointer = path.join(userData, 'library-location.json');
  for (const value of [{ path: 'relative' }, { path: path.join(temp, 'missing') }, { path: resourcesPath }]) {
    fs.writeFileSync(pointer, JSON.stringify(value));
    assert.throws(() => resolveRuntimeLayout({ userData, resourcesPath, release: true }));
  }
});

test('selecting an existing library validates its files and never replaces a pointer', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-select-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const options = { userData: path.join(temp, 'profile'), resourcesPath: path.join(temp, 'Snip.app/Contents/Resources'), release: true };
  const selected = path.join(temp, 'source');
  fs.mkdirSync(options.resourcesPath, { recursive: true });
  fs.mkdirSync(path.join(selected, 'web/.wrangler/state'), { recursive: true });
  fs.mkdirSync(path.join(selected, 'capture'));
  fs.writeFileSync(path.join(selected, 'web/.dev.vars'), 'unchanged');
  assert.throws(() => require('../runtime-layout.cjs').selectExistingLibrary(options, selected), /configuration and local state/);
  fs.writeFileSync(path.join(selected, 'capture/.env'), 'unchanged');
  assert.equal(require('../runtime-layout.cjs').selectExistingLibrary(options, selected).dataRoot, selected);
  assert.throws(() => require('../runtime-layout.cjs').selectExistingLibrary(options, selected), /already recorded/);
  assert.equal(fs.readFileSync(path.join(selected, 'web/.dev.vars'), 'utf8'), 'unchanged');
});

test('failed initialization rolls back its own files and does not touch an existing folder', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-init-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const options = { userData: path.join(temp, 'profile'), resourcesPath: path.join(temp, 'Snip.app/Contents/Resources'), release: true, port: 5173 };
  fs.mkdirSync(options.resourcesPath, { recursive: true });
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated write failure'); };
  try { assert.throws(() => prepareRuntimeLayout(options), /simulated write failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(path.join(options.userData, 'library')), false);
  assert.equal(fs.existsSync(path.join(options.userData, 'library-location.json')), false);
  fs.mkdirSync(path.join(options.userData, 'library'));
  fs.writeFileSync(path.join(options.userData, 'library/canary'), 'foreign');
  assert.throws(() => prepareRuntimeLayout(options), /already exists/);
  assert.equal(fs.readFileSync(path.join(options.userData, 'library/canary'), 'utf8'), 'foreign');
});

test('invalid and moved locations can be repaired without losing the previous pointer', t => {
  const { selectExistingLibrary } = require('../runtime-layout.cjs');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-repair-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const options = { userData: path.join(temp, 'profile'), resourcesPath: path.join(temp, 'Snip.app/Contents/Resources'), release: true };
  const source = path.join(temp, 'source');
  const moved = path.join(temp, 'moved');
  fs.mkdirSync(options.resourcesPath, { recursive: true });
  fs.mkdirSync(path.join(source, 'web/.wrangler/state'), { recursive: true });
  fs.mkdirSync(path.join(source, 'capture'));
  fs.writeFileSync(path.join(source, 'web/.dev.vars'), 'existing');
  fs.writeFileSync(path.join(source, 'capture/.env'), 'existing');
  prepareRuntimeLayout({ ...options, root: source, release: false, recordSource: true });
  const pointer = path.join(options.userData, 'library-location.json');
  const original = fs.readFileSync(pointer, 'utf8');
  fs.renameSync(source, moved);
  assert.throws(() => resolveRuntimeLayout(options), { code: 'SNIP_LIBRARY_LOCATION' });
  assert.throws(() => selectExistingLibrary(options, path.join(temp, 'missing'), { replace: true }), { code: 'SNIP_LIBRARY_LOCATION' });
  assert.equal(fs.readFileSync(pointer, 'utf8'), original);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === pointer) throw new Error('simulated pointer write failure'); return rename(from, to); };
  try { assert.throws(() => selectExistingLibrary(options, moved, { replace: true }), /simulated pointer write failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(pointer, 'utf8'), original);
  assert.equal(selectExistingLibrary(options, moved, { replace: true }).dataRoot, moved);
  assert.equal(fs.readFileSync(`${pointer}.previous`, 'utf8'), original);
  fs.writeFileSync(pointer, 'invalid json');
  assert.throws(() => resolveRuntimeLayout(options), { code: 'SNIP_LIBRARY_LOCATION' });
  assert.equal(selectExistingLibrary(options, moved, { replace: true }).dataRoot, moved);
  assert.equal(fs.readFileSync(`${pointer}.previous`, 'utf8'), 'invalid json');
});

test('unconfigured source startup does not record a library location', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-source-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'source');
  const userData = path.join(temp, 'profile');
  fs.mkdirSync(root);
  prepareRuntimeLayout({ root, userData, release: false, recordSource: true });
  assert.equal(fs.existsSync(path.join(userData, 'library-location.json')), false);
});

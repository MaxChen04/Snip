const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('desktop root Wrangler matches the declared web runtime', () => {
  const root = path.resolve(__dirname, '../..');
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const version = read('web/package.json').devDependencies.wrangler;
  // Desktop launch, provisioning and packaged smoke resolve from the root.
  // Do not let a transitive Vite-plugin dependency select an older runtime.
  assert.equal(read('package.json').devDependencies.wrangler, version);
  assert.equal(read('package-lock.json').packages['node_modules/wrangler'].version, version);
});

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function canonical(target) {
  let ancestor = target;
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}
function within(target, parent) {
  const relative = path.relative(canonical(parent), canonical(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function locationError(message) {
  const error = new Error(message);
  error.code = 'SNIP_LIBRARY_LOCATION';
  return error;
}
function validateDataRoot(dataRoot, resourcesPath) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw locationError('Library location must be an absolute path.');
  // Resources is inside the .app; disallow the entire application bundle.
  const appRoot = resourcesPath && resourcesPath.includes(`.app${path.sep}`)
    ? resourcesPath.slice(0, resourcesPath.indexOf(`.app${path.sep}`) + 4) : resourcesPath;
  if (appRoot && within(dataRoot, appRoot)) throw locationError('Library location cannot be inside the application bundle.');
  return path.resolve(dataRoot);
}
function resolveRuntimeLayout({ root, resourcesPath, userData, release, isolated = false }) {
  if (!path.isAbsolute(userData) || (!release && !path.isAbsolute(root)) || (release && !path.isAbsolute(resourcesPath))) throw new Error('Runtime paths must be absolute.');
  const runtimeRoot = release ? path.join(resourcesPath, 'runtime') : root;
  const pointerPath = path.join(userData, 'library-location.json');
  let dataRoot = release || isolated ? path.join(userData, 'library') : root;
  if ((release || isolated) && fs.existsSync(pointerPath)) {
    let pointer;
    try { pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')); }
    catch { throw locationError('Library location file is invalid.'); }
    dataRoot = pointer && pointer.path;
    if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw locationError('Library location file is invalid.');
    try { if (!fs.statSync(dataRoot).isDirectory()) throw new Error(); }
    catch { throw locationError('The saved library location is unavailable.'); }
    try {
      if (!fs.statSync(path.join(dataRoot, 'web/.dev.vars')).isFile() || !fs.statSync(path.join(dataRoot, 'capture/.env')).isFile()) throw new Error();
    } catch { throw locationError('The saved library configuration is unavailable.'); }
  }
  dataRoot = validateDataRoot(dataRoot, resourcesPath);
  if (isolated && (path.resolve(dataRoot) !== path.join(userData, 'library') || !within(dataRoot, userData))) {
    throw locationError('Snip Dev uses its own test library. It cannot open an external or stable Snip library.');
  }
  return { runtimeRoot, dataRoot, pointerPath, nativeNode: path.join(runtimeRoot, 'node/bin/node'), browsersPath: path.join(runtimeRoot, 'browsers'), webEnvPath: path.join(dataRoot, 'web/.dev.vars'), captureEnvPath: path.join(dataRoot, 'capture/.env') };
}
function writePointer(pointerPath, dataRoot, replace = false) {
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(pointerPath), `.library-location-${crypto.randomBytes(16).toString('hex')}`);
  try {
    fs.writeFileSync(temp, JSON.stringify({ path: dataRoot }) + '\n', { flag: 'wx', mode: 0o600 });
    if (replace && fs.existsSync(pointerPath)) {
      // Save only the previous location record. The library itself is never moved.
      const previous = `${pointerPath}.previous`;
      const previousTemp = `${temp}.previous`;
      try {
        fs.copyFileSync(pointerPath, previousTemp, fs.constants.COPYFILE_EXCL);
        fs.renameSync(previousTemp, previous);
      } finally { try { fs.unlinkSync(previousTemp); } catch {} }
      fs.renameSync(temp, pointerPath);
    } else {
      // Linking publishes the complete file without replacing a concurrent selection.
      fs.linkSync(temp, pointerPath);
    }
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}
function configuredLibrary(dataRoot) {
  try {
    return fs.statSync(path.join(dataRoot, 'web/.dev.vars')).isFile() &&
      fs.statSync(path.join(dataRoot, 'capture/.env')).isFile() &&
      fs.statSync(path.join(dataRoot, 'web/.wrangler/state')).isDirectory();
  } catch { return false; }
}
function prepareRuntimeLayout(options) {
  const layout = resolveRuntimeLayout(options);
  if (!options.release && !options.isolated) {
    if (options.recordSource && configuredLibrary(layout.dataRoot) && !fs.existsSync(layout.pointerPath)) writePointer(layout.pointerPath, layout.dataRoot);
    return layout;
  }
  if (!fs.existsSync(layout.pointerPath)) {
    // An existing directory may contain an interrupted setup or a library. Never replace it.
    if (fs.existsSync(layout.dataRoot)) throw locationError('The default library directory already exists without a location record. Select the library explicitly.');
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('A valid local port is required to initialize the library.');
    const parent = path.dirname(layout.dataRoot);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const stage = fs.mkdtempSync(path.join(parent, '.snip-library-'));
    let created = false;
    try {
      fs.mkdirSync(path.join(stage, 'web'), { mode: 0o700 });
      fs.mkdirSync(path.join(stage, 'capture'), { mode: 0o700 });
      const session = crypto.randomBytes(32).toString('hex');
      const token = crypto.randomBytes(32).toString('hex');
      const origin = `http://localhost:${options.port}`;
      fs.writeFileSync(path.join(stage, 'web/.dev.vars'), `DEV_LOGIN=local\nSESSION_SECRET=${session}\nCAPTURE_TOKEN=${token}\nPUBLIC_URL=${origin}\n`, { flag: 'wx', mode: 0o600 });
      fs.writeFileSync(path.join(stage, 'capture/.env'), `SNIP_URL=${origin}\nCAPTURE_TOKEN=${token}\n`, { flag: 'wx', mode: 0o600 });
      // mkdir is exclusive: never replace a directory created by another process.
      fs.mkdirSync(layout.dataRoot, { mode: 0o700 });
      created = true;
      fs.renameSync(path.join(stage, 'web'), path.join(layout.dataRoot, 'web'));
      fs.renameSync(path.join(stage, 'capture'), path.join(layout.dataRoot, 'capture'));
      writePointer(layout.pointerPath, layout.dataRoot);
    } catch (error) {
      if (created) fs.rmSync(layout.dataRoot, { recursive: true, force: true });
      throw error;
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  return layout;
}
function selectExistingLibrary(options, dataRoot, { replace = false } = {}) {
  if (options.isolated) throw locationError('Snip Dev uses its own test library. Importing an existing library is disabled.');
  if (!options.release) throw new Error('Selecting a library requires a release profile.');
  if (!path.isAbsolute(options.userData) || !path.isAbsolute(options.resourcesPath)) throw new Error('Runtime paths must be absolute.');
  const pointerPath = path.join(options.userData, 'library-location.json');
  if (!replace && fs.existsSync(pointerPath)) throw locationError('A library location is already recorded.');
  const selected = validateDataRoot(dataRoot, options.resourcesPath);
  if (!configuredLibrary(selected)) throw locationError('Select a Snip library containing its web and capture configuration and local state.');
  writePointer(pointerPath, selected, replace);
  return resolveRuntimeLayout(options);
}
module.exports = { resolveRuntimeLayout, prepareRuntimeLayout, selectExistingLibrary, validateDataRoot };

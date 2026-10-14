const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Local development only. Never install into or modify the shared dependency tree.
function configureDevelopmentDependencies(desktopDir = path.resolve(__dirname, '../..')) {
  const file = path.join(desktopDir, '.build', 'development-dependencies.json');
  if (!fs.existsSync(file)) return;
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof config.desktopDir !== 'string' || !path.isAbsolute(config.desktopDir)) {
    throw new Error('开发依赖配置 desktopDir 必须是绝对路径。');
  }
  const hash = root => {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    // App version bumps do not change the installed dependency graph.
    delete lock.version;
    if (lock.packages?.['']) delete lock.packages[''].version;
    return createHash('sha256').update(JSON.stringify(lock)).digest('hex');
  };
  if (hash(desktopDir) !== hash(config.desktopDir)) {
    throw new Error('共享开发依赖的锁文件不一致，请同步本工作树的依赖配置；未修改共享目录。');
  }
  const dependencyRoot = path.join(config.desktopDir, 'node_modules');
  if (!fs.statSync(dependencyRoot).isDirectory()) throw new Error('共享开发依赖目录不可用。');
  process.env.NODE_PATH = [...new Set([dependencyRoot, ...(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)])].join(path.delimiter);
  require('node:module').Module._initPaths();
  return dependencyRoot;
}

module.exports = { configureDevelopmentDependencies };

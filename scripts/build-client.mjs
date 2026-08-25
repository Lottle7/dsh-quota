// scripts/build-client.mjs
// Wraps the bundled client.js in the window.__ModuleLoader__.load envelope
// that the dsh web runtime expects (see @deepseek-ai/dsh-client-modules).
//
// Approach:
// 1. tsdown produces a single ESM file at lib/client.js
// 2. This script post-processes it: top-level imports become require() calls
//    inside a factory closure, top-level exports become module.exports.
// 3. The whole thing is wrapped in window.__ModuleLoader__.load({ id, factory })
//    so the dsh web runtime can materialize it on demand.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ENTRY = process.argv[2]
if (!ENTRY) {
  console.error('usage: node scripts/build-client.mjs <path/to/client.js>')
  process.exit(1)
}
if (!existsSync(ENTRY)) {
  console.error('not found:', ENTRY)
  process.exit(1)
}

const target = resolve(ENTRY)
let source = readFileSync(target, 'utf8')
const scriptDir = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(resolve(scriptDir, '../src/client/styles.css'), 'utf8')

// The client bundle is ESM, while the DSH browser loader evaluates a CommonJS
// factory. Keep only the three plugin exports the loader consumes.
source = source.replace(/^export \{[^}]+\};?\s*$/gm, '')
source = source.replace(/^export\s+(const|let|var|class|function)\s+(\w+)/gm, '$1 $2')
source = source.replace(/^export\s+default\s+/gm, '')

const named = ['name', 'inject', 'apply']

function toDestructuring(specifiers) {
  return specifiers
    .split(',')
    .map((specifier) => {
      const trimmed = specifier.trim()
      const alias = /^(\S+)\s+as\s+(\S+)$/.exec(trimmed)
      return alias === null ? trimmed : `${alias[1]}: ${alias[2]}`
    })
    .join(', ')
}

// Convert top-level `import { X, Y } from 'Z'` to require-style:
//   let { X, Y } = require('Z')
source = source.replace(/^import\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2;?\s*$/gm,
  (_match, specifiers, _quote, packageName) => `const { ${toDestructuring(specifiers)} } = require(${JSON.stringify(packageName)})`)
source = source.replace(/^import\s+\*\s+as\s+(\w+)\s+from\s+(['"])([^'"]+)\2;?\s*$/gm,
  (_match, local, _quote, packageName) => `const ${local} = require(${JSON.stringify(packageName)})`)
source = source.replace(/^import\s+(\w+)\s+from\s+(['"])([^'"]+)\2;?\s*$/gm,
  (_match, local, _quote, packageName) => `const ${local} = require(${JSON.stringify(packageName)})`)
source = source.replace(/^import\s+(['"])([^'"]+)\1;?\s*$/gm, 'require("$2")')

if (/^\s*import\s/m.test(source) || /^\s*export\s/m.test(source)) {
  throw new Error('client bundle contains an unsupported ESM import/export shape')
}
if (/require\((['"])\.\//.test(source)) {
  throw new Error('client bundle contains a relative require(); disable code splitting for DSH client bundles')
}

// Now wrap the entire body in the ModuleLoader envelope.
const expose = named.map((n) => `module.exports.${n} = typeof ${n} !== 'undefined' ? ${n} : void 0`).join('\n')
const wrapped = [
  'window.__ModuleLoader__.load({',
  '  id: "dsh-quota",',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  `    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\\\"dsh-quota/styles.css\\\"]") === null) { const style = document.createElement("style"); style.dataset.plugin = "dsh-quota"; style.dataset.pluginCss = "dsh-quota/styles.css"; style.textContent = ${JSON.stringify(css)}; document.head.appendChild(style); }`,
  source,
  expose,
  '    return module.exports;',
  '  }',
  '});',
].join('\n')

writeFileSync(target, wrapped)
console.log('wrapped:', target)

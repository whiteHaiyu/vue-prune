## vue-prune — Find unused Vue files, assets and code

A small CLI to scan Vue projects and report unused `.vue` components, static assets (images/fonts/media), and code files. It understands common alias setups, dynamic imports, `import.meta.glob`, `require.context`, and global components declared in `.d.ts`.

### Features
- Detects unused `.vue` single-file components
- Detects unused static assets referenced from code, templates, CSS `url(...)`, and `new URL(..., import.meta.url)`
- Detects unreachable code files (JS/TS/JSX/TSX/MJS/CJS)
- Auto-loads aliases from Vite/Webpack/tsconfig/jsconfig
- Supports dynamic import patterns and workers
- Interactive, opt-in deletion flow

### Install
Global install (recommended):

```bash
npm i -g vue-redundant-files
# then use the command:
vue-prune <projectPath> [options]
```

Run without global install (one-off):

```bash
npx -y vue-redundant-files vue-prune <projectPath> [options]
```

An alternative command name is also provided:

```bash
redundant-files <projectPath> [options]
```

Requires Node.js >= 16.

### Usage
Basic scans:

```bash
# scan current directory
vue-prune .

# scan a specific project directory
vue-prune /path/to/project

# verbose logging
vue-prune . --verbose

# save the list of unused .vue files to unused-vue-files.txt
vue-prune . --output

# interactively confirm deletion by category (vue/assets/code)
vue-prune . --delete
```

Help and version:

```bash
vue-prune --help
vue-prune --version
```

### Options
- `--verbose`: Print detailed logs
- `--output`: Save unused `.vue` list to `unused-vue-files.txt` in the project root
- `--delete`: After reporting, interactively confirm deletion by category (TTY only)
- `-v, --version`: Print version
- `-h, --help`: Show help

### How it works (high level)
1. Collects all `.vue` files under the project (excluding ignored directories)
2. Builds a dependency graph from code, styles, HTML, and declarations
3. Detects entry files (e.g., `src/main.ts`, `src/App.vue`, router) and traverses reachable files
4. Merges `.d.ts`-declared global components as used
5. Extracts and resolves asset references from reachable files
6. Reports files/assets not reachable or referenced

### Aliases
The CLI auto-loads aliases from common configs (`vite.config.*`, `webpack.config.*`, `tsconfig.json`, `jsconfig.json`). It also ships with sensible defaults (e.g., `@`, `~`, `_` → `/src`, and `@/components`, `@/views`, etc.). Aliases are normalized to project-root-relative paths (e.g., `/src`).

### Ignored files (for code reachability stats)
Configuration files, tests, mocks, `.d.ts`/types, environment files, and common tooling configs are excluded from the "unused code files" count. This reduces noise and focuses on application code.

### Programmatic usage
You can also use the underlying finder in Node.js:

```js
const UnusedVueFinder = require('vue-redundant-files')

async function run () {
  const finder = new UnusedVueFinder('/path/to/project', { verbose: true })
  const { unusedVueFiles, unusedAssets, unusedCodeFiles } = await finder.findUnusedVueFiles()
  console.log({ unusedVueFiles, unusedAssets, unusedCodeFiles })
}

run().catch(err => {
  console.error(err && err.message ? err.message : err)
  process.exit(1)
})
```

### Safety notes
- Deletion is never automatic. `--delete` enables an interactive, per-category confirmation (requires TTY)
- Always commit your work before removing files
- Dynamic references that are built at runtime may not be detected; review the report before deletion

### License
MIT


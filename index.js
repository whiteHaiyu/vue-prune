#!/usr/bin/env node
// CLI: 扫描 Vue 项目中未被引用的 .vue、静态资源、代码文件；支持别名、动态导入、声明文件全局组件，提供交互式删除（默认不删除）

const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const readline = require("readline");

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);

class UnusedVueFinder {
  constructor(rootDir, options = {}) {
    this.rootDir = rootDir;
    this.options = {
      // 别名（将由配置文件自动合并/覆盖）
      alias: options.alias || {},
      // 扫描源代码文件扩展名（供引用解析使用）
      extensions: options.extensions || [".js", ".ts", ".vue", ".jsx", ".tsx"],
      // 忽略目录（任何子路径包含这些目录名将跳过）
      ignoreDirs: options.ignoreDirs || [
        "node_modules",
        ".git",
        "dist",
        "build",
        "mock",
        "mocks",
        "__mocks__",
        "bin",
        "test",
        "tests",
        "__tests__",
        "env",
      ],
      verbose: options.verbose || false,
      // 样式与静态资源扩展名（用于在内容中识别 url(...) 等资源引用）
      styleExtensions: options.styleExtensions || [".css", ".scss", ".sass", ".less", ".styl"],
      assetExtensions: options.assetExtensions || [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
        ".avif", ".bmp",
        ".mp4", ".webm", ".ogg", ".mp3", ".wav", ".flac", ".aac",
        ".woff", ".woff2", ".ttf", ".otf", ".eot",
        ".ico"
      ],
      // 代码文件扩展与忽略规则（仅用于“未使用代码”统计；不影响依赖解析）
      codeExtensions: options.codeExtensions || [".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"],
      codeIgnorePatterns: options.codeIgnorePatterns || [
        /(^|\/)vite\.config\.(js|ts|mjs|cjs)$/,
        /(^|\/)vue\.config\.(js|ts|mjs|cjs)$/,
        /(^|\/)vitest\.config\.(js|ts|mjs|cjs)$/,
        /(^|\/)jest\.config\.(js|ts|mjs|cjs)$/,
        /(^|\/)cypress\.config\.(js|ts|mjs|cjs)$/,
        /(^|\/)playwright\.config\.(js|ts|mjs|cjs)$/,
        /(^|\/)postcss\.config\.(js|ts|mjs|cjs)$/,
        /(^|\/)tailwind\.config\.(js|ts|mjs|cjs)$/,
        /(^|\/)babel\.config\.(js|ts|mjs|cjs)$/,
        /(^|\/)eslint\..*\.(js|cjs|mjs)$/,
        /(^|\/)prettier\..*\.(js|cjs|mjs)$/,
        /(^|\/)commitlint\..*\.(js|cjs|mjs)$/,
        // dot ESLint configs like .eslintrc.js/.json/.yaml
        /(^|\/)\.eslintrc(\.(js|cjs|mjs|json|ya?ml))?$/,
        // config, mock, bin 目录
        /(^|\/)config\/.*$/,
        /(^|\/)mock\/.*$/,
        /(^|\/)mocks\/.*$/,
        /(^|\/)__mocks__\/.*$/,
        /(^|\/)bin\/.*$/,
        // tests (目录与文件)
        /(^|\/)test\/.*$/,
        /(^|\/)tests\/.*$/,
        /(^|\/)__tests__\/.*$/,
        /(^|\/).*\.(spec|test)\.(js|ts|jsx|tsx|mjs|cjs)$/,
        // TS 声明/类型类文件（不计入“未使用代码”）
        /(^|\/)types\/.*\.(ts|d\.ts)$/,
        /(^|\/)typings\/.*$/,
        /(^|\/)@types\/.*$/,
        /(^|\/)env\.d\.ts$/,
        /(^|\/)auto\-imports\.d\.ts$/,
        /(^|\/)components\.d\.ts$/,
        /(^|\/)shims\-.*\.d\.ts$/,
        /(^|\/)volar.*\.d\.ts$/,
        /(^|\/)typing\.ts$/,
        /(^|\/)typings\.ts$/,
        /(^|\/)types\.ts$/,
        /(^|\/).*\.types\.ts$/,
        // plop 脚手架
        /(^|\/)plop\-templates\/.*$/,
        /(^|\/)plopfile\.js$/,
        // any *.config.* files (JS/TS/MJS/CJS)
        /(^|\/).*\\.config\\\.(js|ts|mjs|cjs)$/,
        // environment files (.env, .env.*)
        /(^|\/)\.env(\..*)?$/,
        // 包含 'mock' 的文件名（不区分大小写）
        /(^|\/).*mock.*\.(js|ts|jsx|tsx|mjs|cjs)$/i,
      ],
      ...options,
    };

    this.allVueFiles = new Set();
    this.referencedFiles = new Set();
    this.importPatterns = [];
    this.graph = new Map();
    this.pathCache = new Map();

    // 静态资源集合（全量与已引用）
    this.allAssetFiles = new Set();
    this.referencedAssets = new Set();

    // 代码文件集合（不含 .vue）
    this.allCodeFiles = new Set();
    // 任何地方被 import/require 到的代码文件（即使入口不可达，仍视为被引用）
    this.referencedCodeFiles = new Set();

    // 从声明文件(.d.ts)识别到的全局组件（视为已用）
    this.usedVueFromDts = new Set();

    // 空目录集合（相对路径）
    this.emptyDirs = [];
  }

  // 导入匹配：尽量覆盖 import/export/require/动态 import/defineAsyncComponent 等
  initImportPatterns() {
    // 通用抓取所有导入字符串，再进行路径解析
    this.importPatterns = [
      /import[\s\S]*?from\s+['"]([^'"\n]+)['"]/g,
      /import\s+['"]([^'"\n]+)['"]/g,
      /export[\s\S]*?from\s+['"]([^'"\n]+)['"]/g,
      /require\(\s*['"]([^'"\n]+)['"]\s*\)/g,
      // 动态 import，支持块/行内注释
      /import\(\s*(?:(?:\/\*[\s\S]*?\*\/\s*)|(?:\/\/[^\n]*\n\s*))*['"]([^'"\n]+)['"]\s*\)/g,
      // defineAsyncComponent(() => import(/* ... */ 'path'))
      /defineAsyncComponent\s*\(\s*\(\)\s*=>\s*import\(\s*(?:(?:\/\*[\s\S]*?\*\/\s*)|(?:\/\/[^\n]*\n\s*))*['"]([^'"\n]+)['"]/g,
    ];
  }

  // 递归获取所有文件（受 ignoreDirs 影响）
  async getAllFiles(dir, fileList = []) {
    try {
      const files = await readdir(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const fileStat = await stat(filePath);
        if (fileStat.isDirectory()) {
          const shouldIgnore = this.options.ignoreDirs.some((ignoreDir) =>
            filePath.includes(ignoreDir)
          );
          if (!shouldIgnore) {
            await this.getAllFiles(filePath, fileList);
          }
        } else {
          fileList.push(filePath);
        }
      }
      return fileList;
    } catch (error) {
      console.error(`Error reading directory ${dir}:`, error.message);
      return fileList;
    }
  }

  // 递归获取所有目录（受 ignoreDirs 影响）
  async getAllDirs(dir, dirList = []) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const shouldIgnore = this.options.ignoreDirs.some((ignoreDir) =>
            full.includes(ignoreDir)
          );
          if (shouldIgnore) continue;
          dirList.push(full);
          await this.getAllDirs(full, dirList);
        }
      }
      return dirList;
    } catch (_) {
      return dirList;
    }
  }

  // 计算空目录（不包含忽略目录；仅判断直接子项是否为空）
  async collectEmptyDirs() {
    const allDirs = await this.getAllDirs(this.rootDir);
    const empties = [];
    for (const abs of allDirs) {
      try {
        const names = fs.readdirSync(abs);
        // 过滤掉忽略目录项
        const filtered = names.filter((name) => {
          const child = path.join(abs, name);
          const ignored = this.options.ignoreDirs.some((ignoreDir) => child.includes(ignoreDir));
          return !ignored;
        });
        if (filtered.length === 0) {
          const rel = path.relative(this.rootDir, abs);
          if (rel) empties.push(rel);
        }
      } catch (_) {}
    }
    this.emptyDirs = empties;
  }

  // 收集全量 .vue 文件（作为候选集）
  async collectVueFiles() {
    console.log("🔍 扫描.vue文件...");
    const allFiles = await this.getAllFiles(this.rootDir);
    for (const file of allFiles) {
      if (file.endsWith(".vue")) {
        const relativePath = path.relative(this.rootDir, file);
        // 跳过 mock 相关路径或文件名
        const relLower = relativePath.toLowerCase();
        if (/(^|\/)(mock|mocks|__mocks__)(\/|$)/i.test(relativePath) || relLower.includes('mock')) {
          continue;
        }
        this.allVueFiles.add(relativePath);
        if (this.options.verbose) {
          console.log(`📁 找到Vue文件: ${relativePath}`);
        }
      }
    }
    console.log(`📊 总共找到 ${this.allVueFiles.size} 个.vue文件`);
  }

  // 收集全量静态资源文件（供“未使用资源”对比）
  async collectAssetFiles() {
    if (this.options.verbose) {
      console.log("🔍 扫描静态资源文件...");
    }
    const allFiles = await this.getAllFiles(this.rootDir);
    const exts = new Set(this.options.assetExtensions);
    for (const file of allFiles) {
      const ext = path.extname(file).toLowerCase();
      if (ext && exts.has(ext)) {
        const relativePath = path.relative(this.rootDir, file);
        // 跳过 mock 相关路径或文件名
        const relLower = relativePath.toLowerCase();
        if (/(^|\/)(mock|mocks|__mocks__)(\/|$)/i.test(relativePath) || relLower.includes('mock')) {
          continue;
        }
        this.allAssetFiles.add(relativePath);
      }
    }
    if (this.options.verbose) {
      console.log(`📊 总共找到 ${this.allAssetFiles.size} 个静态资源文件`);
    }
  }

  // 收集全量代码文件（仅用于“未使用代码”统计）
  async collectCodeFiles() {
    if (this.options.verbose) {
      console.log("🔍 扫描代码文件...");
    }
    const allFiles = await this.getAllFiles(this.rootDir);
    const exts = new Set(this.options.codeExtensions);
    const ignoreRegexes = this.options.codeIgnorePatterns || [];
    for (const file of allFiles) {
      const ext = path.extname(file).toLowerCase();
      if (!ext || !exts.has(ext)) continue;
      if (file.endsWith('.d.ts')) continue;
      const rel = path.relative(this.rootDir, file);
      const ignored = ignoreRegexes.some((re) => re.test(rel));
      if (ignored) continue;
      // 兜底跳过 mock 相关路径或文件名
      const relLower = rel.toLowerCase();
      if (/(^|\/)(mock|mocks|__mocks__)(\/|$)/i.test(rel) || relLower.includes('mock')) continue;
      this.allCodeFiles.add(rel);
    }
    if (this.options.verbose) {
      console.log(`📊 总共找到 ${this.allCodeFiles.size} 个代码文件`);
    }
  }

  // 解析文件中的导入，并将依赖加入图（.d.ts 中的 .vue 计入 usedVueFromDts）
  async parseFileImports(filePath) {
    try {
      const content = await readFile(filePath, "utf8");
      const importerRel = path.relative(this.rootDir, filePath);
      if (!this.graph.has(importerRel)) this.graph.set(importerRel, new Set());
      const isDts = filePath.endsWith('.d.ts');

      for (const pattern of this.importPatterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const specifier = match[1];
          const resolved = this.resolveImportSpecifierToPath(specifier, filePath);
          if (!resolved) continue;
          const targetRel = path.relative(this.rootDir, resolved);
          if (!this.graph.has(importerRel)) this.graph.set(importerRel, new Set());
          this.graph.get(importerRel).add(targetRel);

          if (targetRel.endsWith('.vue')) {
            if (this.allVueFiles.has(targetRel)) {
              this.referencedFiles.add(targetRel);
              if (isDts) {
                this.usedVueFromDts.add(targetRel);
              }
              if (this.options.verbose) {
                console.log(`🔗 找到引用: ${targetRel} <- ${importerRel}`);
              }
            }
          } else {
            // 记录被引用的代码文件
            const isCode = this.allCodeFiles.has(targetRel);
            if (isCode) {
              this.referencedCodeFiles.add(targetRel);
            }
          }
        }
      }

      // 处理 require([...])、require.context、import.meta.glob、new Worker 等
      const requireArrayItems = this.extractRequireArrayDeps(content);
      for (const spec of requireArrayItems) {
        const resolved = this.resolveImportSpecifierToPath(spec, filePath);
        if (!resolved) continue;
        const targetRel = path.relative(this.rootDir, resolved);
        this.graph.get(importerRel).add(targetRel);
      }

      const contextDeps = await this.extractRequireContextDeps(content, filePath);
      for (const abs of contextDeps) {
        const targetRel = path.relative(this.rootDir, abs);
        this.graph.get(importerRel).add(targetRel);
      }

      const globFiles = await this.extractAndExpandGlobs(content, filePath);
      for (const abs of globFiles) {
        const targetRel = path.relative(this.rootDir, abs);
        this.graph.get(importerRel).add(targetRel);
      }

      const workerFiles = this.extractWorkerDeps(content, filePath);
      for (const abs of workerFiles) {
        const targetRel = path.relative(this.rootDir, abs);
        this.graph.get(importerRel).add(targetRel);
      }
    } catch (error) {
      if (this.options.verbose) {
        console.error(`❌ 读取文件失败 ${filePath}:`, error.message);
      }
    }
  }

  // 将模块说明符解析为绝对文件路径：支持别名（含回退）、绝对/相对路径、public 目录、目录 index.*
  resolveImportSpecifierToPath(specifier, importerPath) {
    try {
      // 跳过外部依赖
      if (!specifier.startsWith('.') && !specifier.startsWith('/') && !this.startsWithAnyAlias(specifier)) {
        return null;
      }
      // 去掉查询参数或哈希
      const cleaned = specifier.replace(/[?#].*$/, '');
      let candidate = cleaned;

      // 别名替换（带回退：replacement -> /src -> /）
      for (const alias in this.options.alias) {
        if (candidate === alias || candidate.startsWith(alias + '/')) {
          const remainder = candidate.replace(alias, '').replace(/^\/+/, '');
          const primaryRep = this.options.alias[alias];
          const reps = [];
          const norm = (r) => (r || '').replace(/^\//, '');
          const pushUnique = (r) => { if (!reps.includes(r)) reps.push(r); };

          pushUnique(primaryRep);
          // 常见回退：/src 与 /（项目根）互为兜底
          if (primaryRep !== '/src') pushUnique('/src');
          if (primaryRep !== '/') pushUnique('/');

          for (const rep of reps) {
            const absTry = path.join(this.rootDir, norm(rep), remainder);
            const resolvedTry = this.resolveFileWithExtensions(absTry);
            if (resolvedTry) return resolvedTry;
          }

          // 若均未命中，继续后续逻辑（不立即返回），但移除 alias 前缀以便相对处理
          candidate = remainder;
          break;
        }
      }

      // 绝对路径（以/开头）映射到项目根
      if (candidate.startsWith('/')) {
        const trimmed = candidate.replace(/^\//, '');
        // 尝试项目根与 public 目录
        const absRoot = path.join(this.rootDir, trimmed);
        const absPublic = path.join(this.rootDir, 'public', trimmed);
        const resolvedRoot = this.resolveFileWithExtensions(absRoot);
        if (resolvedRoot) return resolvedRoot;
        const resolvedPublic = this.resolveFileWithExtensions(absPublic);
        if (resolvedPublic) return resolvedPublic;
      }

      // 相对路径
      if (cleaned.startsWith('./') || cleaned.startsWith('../')) {
        const importerDir = path.dirname(importerPath);
        candidate = path.resolve(importerDir, cleaned);
      } else if (!path.isAbsolute(candidate)) {
        // 可能是别名兜底后的相对路径，尝试相对项目根
        candidate = path.join(this.rootDir, candidate);
      }

      // 处理可能存在的尾部斜杠
      candidate = candidate.replace(/\/$/, '');

      const resolved = this.resolveFileWithExtensions(candidate);
      return resolved;
    } catch (error) {
      if (this.options.verbose) {
        console.error(`❌ 解析导入路径失败 ${specifier}:`, error.message);
      }
      return null;
    }
  }

  // 路径是否以任一别名开头
  startsWithAnyAlias(specifier) {
    for (const alias in this.options.alias) {
      if (specifier === alias || specifier.startsWith(alias + '/')) return true;
    }
    return false;
  }

  // 解析具体文件：补扩展名、目录 index.*，含缓存
  resolveFileWithExtensions(filePath) {
    const cacheKey = `resolve:${filePath}`;
    if (this.pathCache.has(cacheKey)) return this.pathCache.get(cacheKey);

    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        const idxCandidates = [
          path.join(filePath, 'index.vue'),
          path.join(filePath, 'index.ts'),
          path.join(filePath, 'index.js'),
          path.join(filePath, 'index.tsx'),
          path.join(filePath, 'index.jsx'),
        ];
        for (const p of idxCandidates) {
          if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            this.pathCache.set(cacheKey, p);
            return p;
          }
        }
      }
    } catch (_) {}

    const tryPaths = [];
    tryPaths.push(filePath + '.vue');
    tryPaths.push(filePath + '.ts');
    tryPaths.push(filePath + '.js');
    tryPaths.push(filePath + '.tsx');
    tryPaths.push(filePath + '.jsx');
    tryPaths.push(filePath + '.mjs');
    tryPaths.push(filePath + '.cjs');
    tryPaths.push(path.join(filePath, 'index.vue'));
    tryPaths.push(path.join(filePath, 'index.ts'));
    tryPaths.push(path.join(filePath, 'index.js'));
    tryPaths.push(path.join(filePath, 'index.tsx'));
    tryPaths.push(path.join(filePath, 'index.jsx'));
    tryPaths.push(filePath);

    for (const p of tryPaths) {
      try {
        if (fs.existsSync(p)) {
          const statInfo = fs.statSync(p);
          if (statInfo.isFile()) {
            this.pathCache.set(cacheKey, p);
            return p;
          }
        }
      } catch (_) {}
    }
    this.pathCache.set(cacheKey, null);
    return null;
  }

  // 其后为 require([...]) / require.context / import.meta.glob / Worker / Glob 工具函数
  // 提取 require([...]) 内的字符串依赖
  extractRequireArrayDeps(content) {
    const result = [];
    const re = /require\(\s*\[([\s\S]*?)\]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const arrBody = m[1];
      const strRe = /['"]([^'"\n]+)['"]/g;
      let s;
      while ((s = strRe.exec(arrBody)) !== null) {
        result.push(s[1]);
      }
    }
    return result;
  }

  // 提取并展开 require.context(dir, recursive, regex)
  async extractRequireContextDeps(content, importerPath) {
    const results = new Set();
    const re = /require\.context\(\s*([^,\)]+)\s*(?:,\s*([^,\)]+))?\s*(?:,\s*([^\)]+))?\)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const rawDir = this.stripQuotes((m[1] || '').trim());
      const recursive = (m[2] || '').trim();
      const rawRegex = (m[3] || '').trim();

      if (!rawDir) continue;
      const absDir = this.resolveImportSpecifierToPath(rawDir, importerPath);
      if (!absDir) continue;
      const dirPath = fs.statSync(absDir).isDirectory() ? absDir : path.dirname(absDir);

      let rx = null;
      if (rawRegex) {
        const parsed = this.parseRegexLiteral(rawRegex);
        if (parsed) rx = parsed;
      }

      const includeSub = /^true$/i.test(recursive);
      const files = await this.getAllFiles(dirPath);
      for (const f of files) {
        if (!includeSub && path.dirname(f) !== dirPath) continue;
        if (rx && !rx.test(f)) continue;
        results.add(f);
      }
    }
    return results;
  }

  stripQuotes(s) {
    if (!s) return s;
    return s.replace(/^['"]|['"]$/g, '');
  }

  parseRegexLiteral(expr) {
    // 形如 /\\.vue$/ 或 new RegExp('\\.vue$')
    const lit = expr.trim();
    const m1 = /^\/(.*)\/([gimyus]*)$/.exec(lit);
    if (m1) {
      try { return new RegExp(m1[1], m1[2] || undefined); } catch (_) { return null; }
    }
    const m2 = /^new\s+RegExp\(\s*['"]([^'"\n]+)['"]\s*(?:,\s*['"]([^'"\n]*)['"])??\)$/.exec(lit);
    if (m2) {
      try { return new RegExp(m2[1], m2[2] || undefined); } catch (_) { return null; }
    }
    return null;
  }

  // 提取 new Worker('...') 和 new Worker(new URL('...', import.meta.url))
  extractWorkerDeps(content, importerPath) {
    const results = new Set();
    let m;
    const w1 = /new\s+Worker\(\s*['"]([^'"\n]+)['"]/g;
    while ((m = w1.exec(content)) !== null) {
      const abs = this.resolveImportSpecifierToPath(m[1], importerPath);
      if (abs) results.add(abs);
    }
    const w2 = /new\s+Worker\(\s*new\s+URL\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
    while ((m = w2.exec(content)) !== null) {
      const abs = this.resolveImportSpecifierToPath(m[1], importerPath);
      if (abs) results.add(abs);
    }
    return results;
  }

  // 解析并展开 import.meta.glob / globEager
  async extractAndExpandGlobs(content, importerPath) {
    const results = new Set();
    const patterns = [];
    let m;
    const g1 = /import\.meta\.glob\(\s*['"]([^'"\n]+)['"]/g;
    while ((m = g1.exec(content)) !== null) patterns.push(m[1]);
    const g2 = /import\.meta\.globEager\(\s*['"]([^'"\n]+)['"]/g;
    while ((m = g2.exec(content)) !== null) patterns.push(m[1]);

    for (const g of patterns) {
      const files = await this.expandGlobToFiles(g, importerPath);
      for (const f of files) results.add(f);
    }
    return results;
  }

  async expandGlobToFiles(globPattern, importerPath) {
    // 解析别名/相对/绝对
    let absPattern = globPattern;
    if (this.startsWithAnyAlias(globPattern) || globPattern.startsWith('/')) {
      const fake = this.resolveImportSpecifierToPath(globPattern.replace(/[*?].*$/, ''), importerPath);
      // 上面仅用于确定基准路径，真正匹配在下方进行
      const aliasResolved = this.resolveAliasInGlob(globPattern, importerPath);
      absPattern = aliasResolved;
    } else if (globPattern.startsWith('./') || globPattern.startsWith('../')) {
      const importerDir = path.dirname(importerPath);
      absPattern = path.resolve(importerDir, globPattern);
    } else {
      absPattern = path.join(this.rootDir, globPattern);
    }

    const baseDir = this.getBaseDirFromGlob(absPattern);
    const regex = this.globToRegex(absPattern);
    const files = await this.getAllFiles(baseDir);
    const matched = [];
    for (const f of files) {
      if (regex.test(f)) matched.push(f);
    }
    return matched;
  }

  resolveAliasInGlob(globPattern, importerPath) {
    let candidate = globPattern;
    for (const alias in this.options.alias) {
      if (candidate === alias || candidate.startsWith(alias + '/')) {
        const replacement = this.options.alias[alias].replace(/^\//, '');
        const remainder = candidate.replace(alias, '').replace(/^\/+/, '');
        candidate = path.join(this.rootDir, replacement, remainder);
        break;
      }
    }
    if (candidate.startsWith('/')) {
      candidate = path.join(this.rootDir, candidate.replace(/^\//, ''));
    }
    if (globPattern.startsWith('./') || globPattern.startsWith('../')) {
      const importerDir = path.dirname(importerPath);
      candidate = path.resolve(importerDir, globPattern);
    }
    return candidate;
  }

  getBaseDirFromGlob(absPattern) {
    const specials = ['*', '?', '[', ']'];
    let idx = -1;
    for (const ch of specials) {
      const i = absPattern.indexOf(ch);
      if (i !== -1) idx = idx === -1 ? i : Math.min(idx, i);
    }
    const base = idx === -1 ? absPattern : absPattern.substring(0, idx);
    const baseDir = fs.existsSync(base) && fs.statSync(base).isDirectory() ? base : path.dirname(base);
    return baseDir;
  }

  globToRegex(absPattern) {
    // 转义正则特殊字符
    let s = absPattern.replace(/[.+^${}()|\\]/g, '\\$&');
    // 处理 ** 和 *
    s = s.replace(/\\\\\*\\\\\*/g, '::DOUBLE_STAR::');
    s = s.replace(/\\\\\*/g, '[^/]*');
    s = s.replace(/::DOUBLE_STAR::/g, '.*');
    // 处理 ?
    s = s.replace(/\\\\\?/g, '.');
    return new RegExp('^' + s + '$');
  }

  // 扫描所有文件中的引用（源文件 + 样式 + .d.ts + .html）
  async scanReferences() {
    console.log("🔍 扫描文件引用...");
    const allFiles = await this.getAllFiles(this.rootDir);
    const exts = new Set([
      ...this.options.extensions,
      ...this.options.styleExtensions,
      '.d.ts',
      '.html',
    ]);
    const targetFiles = allFiles.filter((file) =>
      Array.from(exts).some((ext) => file.endsWith(ext))
    );
    console.log(`📊 扫描 ${targetFiles.length} 个源代码文件`);
    for (const file of targetFiles) {
      await this.parseFileImports(file);
    }
    console.log(`📊 初步识别到 ${this.referencedFiles.size} 个被引用的.vue文件`);
  }

  // 从入口文件出发，遍历依赖图，找出可达的 .vue 文件
  async getReachableVueFiles() {
    const entries = await this.detectEntryFiles();
    if (this.options.verbose) {
      console.log(`🚪 入口文件: ${entries.join(', ')}`);
    }

    const visited = new Set();
    const reachableVue = new Set();
    const queue = [...entries];

    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);

      if (current.endsWith('.vue')) reachableVue.add(current);

      const neighbors = this.graph.get(current);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (!visited.has(n)) queue.push(n);
      }
    }

    return reachableVue;
  }

  // 获取从入口出发可达的所有文件（相对路径）
  async getReachableFiles() {
    const entries = await this.detectEntryFiles();
    const visited = new Set();
    const queue = [...entries];
    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      const neighbors = this.graph.get(current);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (!visited.has(n)) queue.push(n);
      }
    }
    return visited;
  }

  // 从可达文件中提取静态资源引用
  async computeReferencedAssetsFromReachable(reachableFiles) {
    this.referencedAssets.clear();
    const assetExts = new Set(this.options.assetExtensions.map(e => e.toLowerCase()));

    // 1) 先把图可达的资产节点直接标记为已引用，避免漏报（JS/TS/Vue 中通过 import/require 引用的图片等）
    for (const rel of reachableFiles) {
      const ext = path.extname(rel).toLowerCase();
      if (ext && assetExts.has(ext) && this.allAssetFiles.has(rel)) {
        this.referencedAssets.add(rel);
      }
    }

    for (const rel of reachableFiles) {
      const abs = path.join(this.rootDir, rel);
      try {
        const content = await readFile(abs, 'utf8');
        const assetPaths = this.extractAssetReferencesFromContent(content, abs);
        for (const absPath of assetPaths) {
          const relPath = path.relative(this.rootDir, absPath);
          if (this.allAssetFiles.has(relPath)) {
            this.referencedAssets.add(relPath);
            if (this.options.verbose) {
              console.log(`🖼️ 资源引用: ${relPath} <- ${rel}`);
            }
          }
        }
      } catch (_) {}
    }
  }

  // 提取内容中的静态资源路径
  extractAssetReferencesFromContent(content, importerPath) {
    const results = new Set();
    if (!content) return results;

    const pushResolved = (spec) => {
      const cleaned = spec.replace(/[\?#].*$/, '').trim();
      if (!cleaned || /^https?:\/\//i.test(cleaned) || /^data:/i.test(cleaned)) return;
      const abs = this.resolveImportSpecifierToPath(cleaned, importerPath);
      if (abs) results.add(abs);
    };

    // CSS url(...)
    const urlRe = /url\(\s*([^\)]+)\s*\)/gi;
    let m;
    while ((m = urlRe.exec(content)) !== null) {
      const raw = m[1].trim().replace(/^['"]|['"]$/g, '');
      pushResolved(raw);
    }

    // new URL('x', import.meta.url)
    const newUrlRe = /new\s+URL\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
    while ((m = newUrlRe.exec(content)) !== null) {
      pushResolved(m[1]);
    }

    // require('...')（支持在 Vue 模板或脚本中出现）
    const reqRe = /require\(\s*['"]([^'"\n]+)['"]\s*\)/g;
    while ((m = reqRe.exec(content)) !== null) {
      pushResolved(m[1]);
    }

    // import 语句（支持多行）
    const impFromRe = /import[\s\S]*?from\s+['"]([^'"\n]+)['"]/g;
    while ((m = impFromRe.exec(content)) !== null) {
      pushResolved(m[1]);
    }
    const impBareRe = /import\s+['"]([^'"\n]+)['"]/g;
    while ((m = impBareRe.exec(content)) !== null) {
      pushResolved(m[1]);
    }

    // HTML/Vue 模板里的 src/srcset 属性（简化处理）
    const srcRe = /\bsrc\s*=\s*['"]([^'"\n]+)['"]/g;
    while ((m = srcRe.exec(content)) !== null) {
      pushResolved(m[1]);
    }
    const srcsetRe = /\bsrcset\s*=\s*['"]([^'"\n]+)['"]/g;
    while ((m = srcsetRe.exec(content)) !== null) {
      const items = m[1].split(',');
      for (const item of items) {
        const url = item.trim().split(/\s+/)[0];
        if (url) pushResolved(url);
      }
    }

    return results;
  }

  // 自动从常见配置文件中探测别名：支持 .set('alias', resolve('src'))、Vite alias 对象/数组、tsconfig/jsconfig paths
  async loadAliasesFromConfigs() {
    const mergeAlias = (map) => {
      if (!map) return;
      for (const key in map) {
        const val = map[key];
        const normalized = this.normalizeAliasReplacement(val);
        const existed = this.options.alias[key];
        const absCandidate = path.resolve(this.rootDir, normalized.replace(/^\//, ''));
        const relTest = path.relative(this.rootDir, absCandidate);
        const insideRoot = relTest === '' || (!relTest.startsWith('..') && !path.isAbsolute(relTest));
        const exists = fs.existsSync(absCandidate);
        if (insideRoot && exists) {
          this.options.alias[key] = normalized;
          if (this.options.verbose) {
            if (existed && existed !== normalized) {
              console.log(`🧭 覆盖别名: '${key}' ${existed} -> ${normalized}`);
            } else {
              console.log(`🧭 发现别名: '${key}' -> '${normalized}'`);
            }
          }
        } else if (this.options.verbose) {
          console.log(`⚠️ 跳过别名(越界或不存在): '${key}' -> '${normalized}'`);
        }
      }
    };

    // 读取文本类配置
    const candidates = [
      'vite.config.ts',
      'vite.config.js',
      'vite.config.mjs',
      'vite.config.cjs',
      'vue.config.js',
      'webpack.config.js',
      'webpack.config.ts',
      'jsconfig.json',
      'tsconfig.json',
    ];

    for (const rel of candidates) {
      const abs = path.join(this.rootDir, rel);
      try {
        if (!fs.existsSync(abs)) continue;
        if (rel.endsWith('.json')) {
          const json = JSON.parse(fs.readFileSync(abs, 'utf8'));
          const paths = json && json.compilerOptions && json.compilerOptions.paths;
          const baseUrl = (json && json.compilerOptions && json.compilerOptions.baseUrl) ? json.compilerOptions.baseUrl : '.';
          const cfgDir = path.dirname(abs);
          const baseAbs = path.resolve(cfgDir, baseUrl);
          if (paths) {
            const aliasMap = {};
            for (const k in paths) {
              // 处理形如 '@/*': ['src/*']
              const key = k.replace(/\/*$/, '');
              const arr = Array.isArray(paths[k]) ? paths[k] : [paths[k]];
              if (arr.length > 0) {
                const first = arr[0].replace(/\/*$/, '');
                const absTarget = path.resolve(baseAbs, first);
                const relToRoot = path.relative(this.rootDir, absTarget).replace(/\\/g, '/');
                aliasMap[key] = '/' + relToRoot.replace(/^\//, '');
              }
            }
            mergeAlias(aliasMap);
          }
        } else {
          const content = fs.readFileSync(abs, 'utf8');
          const aliasMap = {};
          // 匹配 Map.set('alias', resolve('path')) 形式
          const setRe = /\.set\(\s*['"]([^'"\n]+)['"]\s*,\s*resolve\(\s*['"]([^'"\n]+)['"]\s*\)\s*\)/g;
          let m;
          while ((m = setRe.exec(content)) !== null) {
            const key = m[1];
            const p = m[2];
            aliasMap[key] = '/' + p.replace(/^\//, '').replace(/^\.\//, '');
          }

          // 匹配 alias: { '@': resolve('src'), '_': resolve('src') }
          const objRe = /alias\s*:\s*\{([\s\S]*?)\}/g;
          while ((m = objRe.exec(content)) !== null) {
            const body = m[1];
            const pairRe = /['"]([^'"\n]+)['"]\s*:\s*(?:resolve\(\s*['"]([^'"\n]+)['"]\s*\)|['"]([^'"\n]+)['"])/g;
            let p2;
            while ((p2 = pairRe.exec(body)) !== null) {
              const key = p2[1];
              const pathResolved = p2[2] || p2[3];
              if (pathResolved) {
                aliasMap[key] = '/' + pathResolved.replace(/^\//, '').replace(/^\.\//, '');
              }
            }
          }

          // 匹配 Vite 数组形式：alias: [{ find: '_', replacement: resolve('src') }]
          const arrRe = /alias\s*:\s*\[([\s\S]*?)\]/g;
          while ((m = arrRe.exec(content)) !== null) {
            const body = m[1];
            const itemRe = /\{[\s\S]*?find\s*:\s*['"]([^'"\n]+)['"][\s\S]*?replacement\s*:\s*(?:resolve\(\s*['"]([^'"\n]+)['"]\s*\)|['"]([^'"\n]+)['"])\s*[\s\S]*?\}/g;
            let p3;
            while ((p3 = itemRe.exec(body)) !== null) {
              const key = p3[1];
              const pathResolved = p3[2] || p3[3];
              if (pathResolved) {
                aliasMap[key] = '/' + pathResolved.replace(/^\//, '').replace(/^\.\//, '');
              }
            }
          }

          mergeAlias(aliasMap);
        }
      } catch (e) {
        if (this.options.verbose) {
          console.log(`⚠️ 读取别名配置失败 ${rel}: ${e.message}`);
        }
      }
    }
  }

  normalizeAliasReplacement(val) {
    if (!val) return val;
    if (val.startsWith('/')) return val;
    return '/' + val.replace(/^\//, '').replace(/^\.\//, '');
  }

  // 入口识别：常见 main.*、App.vue、router/index.*，如找不到则兜底
  async detectEntryFiles() {
    const candidates = [
      'main.ts', 'main.js', 'main.mjs', 'main.cjs',
      'src/main.ts', 'src/main.js', 'src/main.mjs', 'src/main.cjs',
      'src/App.vue', 'App.vue',
      'src/router/index.ts', 'src/router/index.js',
      'router/index.ts', 'router/index.js',
    ];
    const found = [];
    for (const rel of candidates) {
      const abs = path.join(this.rootDir, rel);
      if (fs.existsSync(abs)) found.push(rel);
    }
    if (found.length === 0) {
      const allFiles = await this.getAllFiles(this.rootDir);
      const codeFiles = allFiles.filter((f) => /\.(js|ts|mjs|cjs|jsx|tsx|vue)$/.test(f));
      for (const f of codeFiles) {
        try {
          const content = await readFile(f, 'utf8');
          if (/createApp\s*\(|new\s+Vue\s*\(/.test(content)) {
            found.push(path.relative(this.rootDir, f));
          }
        } catch (_) {}
      }
    }
    if (found.length === 0) {
      for (const key of this.graph.keys()) {
        found.push(key);
        if (found.length >= 3) break;
      }
    }
    return found;
  }

  // 主流程：收集 -> 构图 -> 计算可达 -> 合并 .d.ts 全局组件 -> 输出结果
  async findUnusedVueFiles() {
    console.log("🚀 开始查找未使用的.vue文件...\n");

    await this.loadAliasesFromConfigs();
    this.initImportPatterns();
    await this.collectVueFiles();
    await this.collectAssetFiles();
    await this.collectCodeFiles();
    await this.collectEmptyDirs();
    await this.scanReferences();

    const reachableVue = await this.getReachableVueFiles();
    // 合并 .d.ts 注册的全局组件
    const finalUsedVue = new Set([...reachableVue, ...this.usedVueFromDts]);
    const reachableFiles = await this.getReachableFiles();
    await this.computeReferencedAssetsFromReachable(reachableFiles);

    const unusedFiles = [];
    for (const vueFile of this.allVueFiles) {
      if (!finalUsedVue.has(vueFile)) {
        unusedFiles.push(vueFile);
      }
    }

    const unusedAssets = [];
    for (const asset of this.allAssetFiles) {
      if (!this.referencedAssets.has(asset)) {
        unusedAssets.push(asset);
      }
    }

    const unusedCodeFiles = [];
    for (const codeFile of this.allCodeFiles) {
      if (!reachableFiles.has(codeFile)) {
        // 若代码文件与已使用的 .vue 组件成对（同目录同名或 index.{js,ts} + index.vue），视为包装文件，不报未使用
        const codeDir = path.dirname(codeFile);
        const base = path.basename(codeFile, path.extname(codeFile));
        const sameBaseVue = path.join(codeDir, base + '.vue');
        const indexVue = path.join(codeDir, 'index.vue');
        const pairsWithUsedVue = (this.allVueFiles.has(sameBaseVue) && finalUsedVue.has(sameBaseVue)) ||
          (base === 'index' && this.allVueFiles.has(indexVue) && finalUsedVue.has(indexVue));
        if (pairsWithUsedVue) {
          continue;
        }
        unusedCodeFiles.push(codeFile);
      }
    }

    console.log("\n📋 结果报告:");
    console.log("══════════════════════════════════════");
    console.log(`📊 总Vue文件数: ${this.allVueFiles.size}`);
    console.log(`🔗 可达(被实际引用)文件数: ${finalUsedVue.size}`);
    console.log(`🚫 未使用文件数: ${unusedFiles.length}`);
    console.log(`\n📦 总静态资源数: ${this.allAssetFiles.size}`);
    console.log(`🖼️ 被引用资源数: ${this.referencedAssets.size}`);
    console.log(`🗑️ 未使用资源数: ${unusedAssets.length}`);
    console.log(`\n🧩 总代码文件数(不含 .vue): ${this.allCodeFiles.size}`);
    console.log(`🧭 可达代码文件数: ${Array.from(reachableFiles).filter(f => this.allCodeFiles.has(f)).length}`);
    console.log(`🗑️ 未使用代码文件数: ${unusedCodeFiles.length}`);
    console.log("══════════════════════════════════════\n");

    if (unusedFiles.length > 0) {
      console.log("📝 未使用的.vue文件列表:");
      unusedFiles.forEach((file, index) => {
        console.log(`${index + 1}. ${file}`);
      });
    } else {
      console.log("🎉 恭喜！没有找到未使用的.vue文件。");
    }

    if (unusedAssets.length > 0) {
      console.log("\n📝 未使用的静态资源文件列表:");
      unusedAssets.forEach((file, index) => {
        console.log(`${index + 1}. ${file}`);
      });
    } else {
      console.log("\n🎉 恭喜！没有找到未使用的静态资源文件。");
    }

    if (unusedCodeFiles.length > 0) {
      console.log("\n📝 未使用的代码文件列表 (JS/TS/JSX/TSX/MJS/CJS):");
      unusedCodeFiles.forEach((file, index) => {
        console.log(`${index + 1}. ${file}`);
      });
    } else {
      console.log("\n🎉 恭喜！没有找到未使用的代码文件。");
    }

    if (this.emptyDirs.length > 0) {
      console.log("\n📝 空目录列表:");
      this.emptyDirs.forEach((dir, index) => {
        console.log(`${index + 1}. ${dir}`);
      });
    } else {
      console.log("\n🎉 恭喜！没有找到空目录。");
    }

    return { unusedVueFiles: unusedFiles, unusedAssets, unusedCodeFiles, emptyDirs: this.emptyDirs };
  }
}

function isSubPath(parent, candidate) {
  const parentResolved = path.resolve(parent);
  const candidateResolved = path.resolve(candidate);
  return candidateResolved === parentResolved || candidateResolved.startsWith(parentResolved + path.sep);
}

async function confirmAndOptionallyDelete(rootDir, sections) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a)));
  try {
    const yn = (s) => /^y(es)?$/i.test((s || "").trim());

    const hasVue = sections.vue && sections.vue.length > 0;
    const hasAssets = sections.assets && sections.assets.length > 0;
    const hasCode = sections.code && sections.code.length > 0;
    const hasDirs = sections.dirs && sections.dirs.length > 0;

    if (!hasVue && !hasAssets && !hasCode && !hasDirs) return;

    console.log("🛡️ 删除为不可逆操作，建议先提交一次代码备份。");

    if (hasVue) {
      const a = await ask(`是否删除未使用的 .vue 文件 (${sections.vue.length} 个)? [y/N] `);
      if (yn(a)) deleteFilesSafely(rootDir, sections.vue);
    }
    if (hasAssets) {
      const a = await ask(`是否删除未使用的静态资源 (${sections.assets.length} 个)? [y/N] `);
      if (yn(a)) deleteFilesSafely(rootDir, sections.assets);
    }
    if (hasCode) {
      const a = await ask(`是否删除未使用的代码文件 (${sections.code.length} 个)? [y/N] `);
      if (yn(a)) deleteFilesSafely(rootDir, sections.code);
    }
    if (hasDirs) {
      const a = await ask(`是否删除空目录 (${sections.dirs.length} 个)? [y/N] `);
      if (yn(a)) deleteDirsSafely(rootDir, sections.dirs);
    }
  } finally {
    rl.close();
  }
}

function deleteFilesSafely(rootDir, relativeFiles) {
  let deleted = 0;
  for (const rel of relativeFiles) {
    const abs = path.join(rootDir, rel);
    try {
      if (!isSubPath(rootDir, abs)) continue;
      const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
      if (!st || !st.isFile()) continue;
      fs.unlinkSync(abs);
      deleted += 1;
      console.log(`🗑️ 已删除: ${rel}`);
    } catch (e) {
      console.warn(`⚠️ 删除失败: ${rel} -> ${e.message}`);
    }
  }
  console.log(`✅ 删除完成，共删除 ${deleted} 个文件`);
}

function deleteDirsSafely(rootDir, relativeDirs) {
  let deleted = 0;
  for (const rel of relativeDirs) {
    const abs = path.join(rootDir, rel);
    try {
      if (!isSubPath(rootDir, abs)) continue;
      if (!fs.existsSync(abs)) continue;
      const entries = fs.readdirSync(abs);
      if (entries.length === 0) {
        fs.rmdirSync(abs);
        deleted += 1;
        console.log(`📁 已删除空目录: ${rel}`);
      }
    } catch (e) {
      console.warn(`⚠️ 删除目录失败: ${rel} -> ${e.message}`);
    }
  }
  console.log(`✅ 空目录删除完成，共删除 ${deleted} 个目录`);
}

// CLI 入口：必须显式传项目路径；不传则提示并退出
async function main() {
  const argv = process.argv.slice(2);
  const pathArg = argv.find(a => a && !a.startsWith('-'));
  if (!pathArg) {
    console.error('❌ 未指定路径。请执行：vue-prune <projectPath> [options]');
    process.exit(1);
  }
  const rootDirectory = path.resolve(process.cwd(), pathArg);

  const options = {
    alias: {
      "@": "/src",
      "~": "/src",
      "_": "/src",
      "@/components": "/src/components",
      "@/views": "/src/views",
      "_/components": "/src/components",
      "_/views": "/src/views",
    },
    verbose: process.argv.includes("--verbose"),
  };

  const finder = new UnusedVueFinder(rootDirectory, options);
  try {
    const { unusedVueFiles, unusedAssets, unusedCodeFiles, emptyDirs } = await finder.findUnusedVueFiles();
    // 可选输出 .vue 清单
    if (unusedVueFiles.length > 0 && process.argv.includes("--output")) {
      const outputPath = path.join(rootDirectory, "unused-vue-files.txt");
      fs.writeFileSync(outputPath, unusedVueFiles.join("\n"));
      console.log(`\n💾 结果已保存到: ${outputPath}`);
    }
    // 交互式删除：仅当显式传入 --delete 且在 TTY 环境才启用
    if (process.argv.includes("--delete") &&
      (unusedVueFiles.length > 0 || unusedAssets.length > 0 || unusedCodeFiles.length > 0 || emptyDirs.length > 0) &&
      process.stdin.isTTY && process.stdout.isTTY) {
      await confirmAndOptionallyDelete(rootDirectory, { vue: unusedVueFiles, assets: unusedAssets, code: unusedCodeFiles, dirs: emptyDirs });
    }
  } catch (error) {
    console.error("❌ 执行失败:", error.message);
    process.exit(1);
  }
}

// 帮助信息
if (process.argv.includes("-v") || process.argv.includes("--version")) {
  try {
    const pkg = require('./package.json');
    console.log(pkg.version || '0.0.0');
  } catch (_) {
    console.log('0.0.0');
  }
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
    用法: vue-prune [目录路径] [选项]

    选项:
    --verbose     显示详细输出
    --output      将结果保存到文件
    --delete      输出列表后逐类确认是否删除（默认不删除）
    -v, --version 输出版本号
    --help, -h    显示帮助信息

    示例:
    vue-prune .                         # 扫描当前目录
    vue-prune /path/to/project         # 扫描指定目录
    vue-prune --verbose               # 详细模式
    vue-prune --output                # 保存结果到文件
    vue-prune --delete                # 执行后询问是否删除
  `);
  process.exit(0);
}

// 执行主函数
if (require.main === module) {
  main();
}

module.exports = UnusedVueFinder;

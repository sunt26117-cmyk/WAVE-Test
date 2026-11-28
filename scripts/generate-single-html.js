import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const distDir = path.resolve('dist');
const assetsDir = path.join(distDir, 'assets');

if (!fs.existsSync(distDir) || !fs.existsSync(assetsDir)) {
  console.error('dist/assets directory does not exist. Run vite build first.');
  process.exit(1);
}

let html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf-8');

const assetEntries = fs.readdirSync(assetsDir);
const allCssFiles = assetEntries.filter((f) => f.endsWith('.css')).sort();
const allJsFiles = assetEntries.filter((f) => f.endsWith('.js')).sort();

// 1. Inline ALL CSS files (linked stylesheets first, followed by any lazy-chunk CSS)
const linkedCssFiles = new Set();
const cssChunks = [];

html = html.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+\.css)["'][^>]*>\s*/gi, (match, href) => {
  const fileName = path.basename(href);
  const fullPath = path.join(assetsDir, fileName);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Referenced stylesheet not found in dist/assets: ${fileName}`);
  }
  linkedCssFiles.add(fileName);
  cssChunks.push(`/* ${fileName} */\n${fs.readFileSync(fullPath, 'utf-8')}`);
  return '';
});

for (const cssFile of allCssFiles) {
  if (!linkedCssFiles.has(cssFile)) {
    cssChunks.push(`/* ${cssFile} */\n${fs.readFileSync(path.join(assetsDir, cssFile), 'utf-8')}`);
  }
}

if (cssChunks.length > 0) {
  const combinedCss = cssChunks.join('\n\n').replace(/<\/style>/gi, '<\\/style>');
  html = html.replace(/<\/head>/i, () => `<style>\n${combinedCss}\n</style>\n</head>`);
}

// 2. Strip external modulepreload / preload links (all chunks will be inlined)
html = html.replace(/<link\b[^>]*rel=["'](?:modulepreload|preload)["'][^>]*href=["'][^"']+assets\/[^"']+["'][^>]*>\s*/gi, '');

// 3. Resolve entry module script from dist/index.html and bundle ALL JS chunks safely
const entryScripts = [];
html = html.replace(
  /<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+\.js)["'][^>]*><\/script>\s*/gi,
  (_match, src) => {
    entryScripts.push(src);
    return '';
  }
);

if (entryScripts.length === 0) {
  throw new Error('Could not find <script type="module" src="...js"> entry tag in dist/index.html.');
}

const resolvedEntries = entryScripts.map((src) => {
  const fileName = path.basename(src);
  const fullPath = path.join(assetsDir, fileName);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Entry JS file referenced in dist/index.html is missing: ${fullPath}`);
  }
  return fullPath;
});

let bundledJs = '';
let bundledChunkCount = 0;

if (allJsFiles.length === 1 && resolvedEntries.length === 1) {
  bundledJs = fs.readFileSync(resolvedEntries[0], 'utf-8');
  bundledChunkCount = 1;
} else {
  // Multi-chunk code-split build: re-bundle entry + all static/dynamic local chunks into one self-contained ESM bundle
  const syntheticEntry = resolvedEntries.map((p) => `import ${JSON.stringify(p)};`).join('\n');
  const result = esbuild.buildSync({
    stdin: {
      contents: syntheticEntry,
      resolveDir: assetsDir,
      loader: 'js',
    },
    bundle: true,
    splitting: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });

  if (result.errors.length > 0 || !result.outputFiles || result.outputFiles.length === 0) {
    throw new Error(`esbuild failed to bundle multi-chunk JS: ${result.errors.map((e) => e.text).join('; ')}`);
  }

  const includedAssets = new Set(
    Object.keys(result.metafile?.inputs || {})
      .map((p) => path.resolve(p))
      .filter((p) => p.startsWith(assetsDir + path.sep))
      .map((p) => path.basename(p))
  );
  const droppedChunks = allJsFiles.filter((f) => !includedAssets.has(f));
  if (droppedChunks.length > 0) {
    throw new Error(
      `Standalone HTML build refused to silently drop JS chunk(s): ${droppedChunks.join(', ')}`
    );
  }

  bundledJs = result.outputFiles[0].text;
  bundledChunkCount = includedAssets.size;

  // Neutralize Vite's runtime CSS preload link injection for already-inlined assets/*.css
  bundledJs = bundledJs.replace(
    /document\.head\.appendChild\(([a-zA-Z_$][\w$]*)\)/g,
    '($1&&$1.tagName==="LINK"&&typeof $1.href==="string"&&$1.href.includes("/assets/")?void 0:document.head.appendChild($1))'
  );
}

const safeJs = bundledJs.replace(/<\/script>/gi, '<\\/script>');
html = html.replace(/<\/body>/i, () => `<script type="module">\n${safeJs}\n</script>\n</body>`);

const outputPath = path.join(distDir, 'waveform-viewer-standalone.html');
fs.writeFileSync(outputPath, html, 'utf-8');

const publicDir = path.resolve('public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}
const publicOutputPath = path.join(publicDir, 'waveform-viewer-standalone.html');
fs.writeFileSync(publicOutputPath, html, 'utf-8');

// JSON-wrapped copy is served as application/json so reverse proxies cannot inject HTML/scripts into downloaded offline HTML
const publicJsonPath = path.join(publicDir, 'waveform-viewer-offline.json');
fs.writeFileSync(publicJsonPath, JSON.stringify({ html }), 'utf-8');

const rootOutputPath = path.resolve('waveform-viewer-pro.html');
fs.writeFileSync(rootOutputPath, html, 'utf-8');

const entrySizeKb = (fs.statSync(resolvedEntries[0]).size / 1024).toFixed(1);
const standaloneSizeKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
console.log(
  `Successfully generated standalone HTML (${bundledChunkCount} JS chunk(s), ${cssChunks.length} CSS file(s) inlined; web entry ${entrySizeKb} KB, standalone ${standaloneSizeKb} KB): ${outputPath}, ${publicOutputPath}, ${publicJsonPath}, and ${rootOutputPath}`
);

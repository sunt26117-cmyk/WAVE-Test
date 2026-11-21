import fs from 'fs';
import path from 'path';

const distDir = path.resolve('dist');
const assetsDir = path.join(distDir, 'assets');

if (!fs.existsSync(distDir)) {
  console.error('dist directory does not exist. Run npm run build first.');
  process.exit(1);
}

let html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf-8');

// Find CSS file and inline into <head>
const cssFiles = fs.readdirSync(assetsDir).filter(f => f.endsWith('.css'));
if (cssFiles.length > 0) {
  const cssContent = fs.readFileSync(path.join(assetsDir, cssFiles[0]), 'utf-8');
  html = html.replace(
    /<link rel="stylesheet"[^>]+href="[^"]+\.css"[^>]*>/i,
    () => `<style>\n${cssContent}\n</style>`
  );
}

// Find JS file, strip original <script> tag from <head>, and place inline <script type="module"> right before </body>
const jsFiles = fs.readdirSync(assetsDir).filter(f => f.endsWith('.js'));
if (jsFiles.length > 0) {
  const rawJs = fs.readFileSync(path.join(assetsDir, jsFiles[0]), 'utf-8');
  const safeJs = rawJs.replace(/<\/script>/gi, '<\\/script>');
  html = html.replace(/<script type="module"[^>]+src="[^"]+\.js"[^>]*><\/script>\s*/i, '');
  html = html.replace(
    /<\/body>/i,
    () => `<script type="module">\n${safeJs}\n</script>\n</body>`
  );
}

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

console.log(`Successfully generated standalone HTML: ${outputPath}, ${publicOutputPath}, ${publicJsonPath}, and ${rootOutputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);

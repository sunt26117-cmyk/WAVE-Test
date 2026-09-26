import fs from 'fs';
import path from 'path';

const distDir = path.resolve('dist');
const assetsDir = path.join(distDir, 'assets');

if (!fs.existsSync(distDir)) {
  console.error('dist directory does not exist. Run npm run build first.');
  process.exit(1);
}

let html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf-8');

// Find CSS file
const cssFiles = fs.readdirSync(assetsDir).filter(f => f.endsWith('.css'));
if (cssFiles.length > 0) {
  const cssContent = fs.readFileSync(path.join(assetsDir, cssFiles[0]), 'utf-8');
  // Replace <link rel="stylesheet" ... href="/assets/..."> with <style>...</style>
  html = html.replace(/<link rel="stylesheet"[^>]+href="[^"]+\.css"[^>]*>/i, `<style>\n${cssContent}\n</style>`);
}

// Find JS file
const jsFiles = fs.readdirSync(assetsDir).filter(f => f.endsWith('.js'));
if (jsFiles.length > 0) {
  const jsContent = fs.readFileSync(path.join(assetsDir, jsFiles[0]), 'utf-8');
  // Replace <script type="module"[^>]+src="[^"]+\.js"><\/script> with <script type="module">...</script>
  html = html.replace(/<script type="module"[^>]+src="[^"]+\.js"><\/script>/i, `<script type="module">\n${jsContent}\n</script>`);
}

const outputPath = path.join(distDir, 'waveform-viewer-standalone.html');
fs.writeFileSync(outputPath, html, 'utf-8');

const publicDir = path.resolve('public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}
const publicOutputPath = path.join(publicDir, 'waveform-viewer-standalone.html');
fs.writeFileSync(publicOutputPath, html, 'utf-8');

console.log(`Successfully generated standalone HTML: ${outputPath} and ${publicOutputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);

/**
 * Switch Mode Utility
 * Toggles root index.html and sw.js between:
 * - 'prod': Uses obfuscated app.bundle.js (Zero human-readable code loaded in browser)
 * - 'dev':  Uses modular app.js and src/*.js (Full debugging & local development)
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const mode = (process.argv[2] || '').toLowerCase().trim();

if (mode !== 'prod' && mode !== 'dev') {
  console.log('Usage: node scripts/switch-mode.js [prod|dev]');
  process.exit(1);
}

const htmlPath = path.join(ROOT_DIR, 'index.html');
const swPath = path.join(ROOT_DIR, 'sw.js');
const bundlePath = path.join(ROOT_DIR, 'app.bundle.js');

let htmlContent = fs.readFileSync(htmlPath, 'utf-8');
let swContent = fs.readFileSync(swPath, 'utf-8');

if (mode === 'prod') {
  if (!fs.existsSync(bundlePath)) {
    console.error('❌ "app.bundle.js" not found! Run "npm run build" first to generate the obfuscated bundle.');
    process.exit(1);
  }

  // Update index.html
  htmlContent = htmlContent.replace(
    /<script\s+type="module"\s+src="\.\/app\.js"><\/script>/i,
    '<script type="module" src="./app.bundle.js"></script>'
  );

  // Update sw.js
  swContent = swContent.replace(
    /const ASSETS_TO_CACHE = \[[\s\S]*?\];/,
    `const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './src/styles.css',
  './app.bundle.js',
  './manifest.json',
  './icon-512.png'
];`
  );

  fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
  fs.writeFileSync(swPath, swContent, 'utf-8');

  console.log('🔒 =============================================================');
  console.log('   PRODUCTION MODE ACTIVATED (OBFUSCATED)');
  console.log('   Root index.html is now running: app.bundle.js');
  console.log('   All business logic, prompts, and math are completely scrambled.');
  console.log('   Browser DevTools cannot read or duplicate the source code.');
  console.log('================================================================');
} else {
  // Update index.html
  htmlContent = htmlContent.replace(
    /<script\s+type="module"\s+src="\.\/app\.bundle\.js"><\/script>/i,
    '<script type="module" src="./app.js"></script>'
  );

  // Update sw.js
  swContent = swContent.replace(
    /const ASSETS_TO_CACHE = \[[\s\S]*?\];/,
    `const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './src/styles.css',
  './app.js',
  './src/attendanceCalculator.js',
  './src/pdfExporter.js',
  './src/ocrExtractor.js',
  './src/sampleData.js',
  './manifest.json'
];`
  );

  fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
  fs.writeFileSync(swPath, swContent, 'utf-8');

  console.log('🔓 =============================================================');
  console.log('   DEVELOPMENT MODE ACTIVATED');
  console.log('   Root index.html is now running modular: app.js & src/*.js');
  console.log('   Full debugging, console logs, and source inspection enabled.');
  console.log('================================================================');
}

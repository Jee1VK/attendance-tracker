/**
 * Automated Production Bundling & Code Obfuscation Pipeline
 * Uses esbuild to bundle modules and javascript-obfuscator to scramble AST.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist-protected');
const CONFIG_PATH = path.join(ROOT_DIR, 'obfuscator.config.json');

console.log('🛡️  Starting Code Obfuscation & Security Hardening Pipeline...\n');

// 1. Verify required CLI tools
try {
  execSync('esbuild --version', { stdio: 'ignore', shell: true });
  execSync('javascript-obfuscator --version', { stdio: 'ignore', shell: true });
} catch (err) {
  console.error('❌ Required global tools missing. Please run:\n  npm install -g esbuild javascript-obfuscator\n');
  process.exit(1);
}

// 2. Prepare output directories
if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}
const distSrcDir = path.join(DIST_DIR, 'src');
if (!fs.existsSync(distSrcDir)) {
  fs.mkdirSync(distSrcDir, { recursive: true });
}

// 3. Bundle app.js and imported modules with esbuild
console.log('📦 Step 1: Bundling application modules with esbuild...');
const tempBundlePath = path.join(ROOT_DIR, 'temp-bundle.js');
try {
  execSync(`esbuild "${path.join(ROOT_DIR, 'app.js')}" --bundle --format=esm --outfile="${tempBundlePath}"`, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    shell: true
  });
} catch (err) {
  console.error('❌ esbuild bundling failed:', err.message);
  process.exit(1);
}

const rawBundleSize = fs.statSync(tempBundlePath).size;
console.log(`   ✓ Raw module bundle generated: ${(rawBundleSize / 1024).toFixed(1)} KB`);

// 4. Scramble AST with javascript-obfuscator
console.log('\n🔒 Step 2: Applying AST scrambling, control flow flattening, and string encryption...');
const rootProtectedBundle = path.join(ROOT_DIR, 'app.bundle.js');
const distProtectedBundle = path.join(DIST_DIR, 'app.bundle.js');

try {
  execSync(`javascript-obfuscator "${tempBundlePath}" --output "${distProtectedBundle}" --config "${CONFIG_PATH}"`, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    shell: true
  });
  // Also copy to root for optional in-place serving
  fs.copyFileSync(distProtectedBundle, rootProtectedBundle);
} catch (err) {
  console.error('❌ javascript-obfuscator failed:', err.message);
  if (fs.existsSync(tempBundlePath)) fs.unlinkSync(tempBundlePath);
  process.exit(1);
} finally {
  if (fs.existsSync(tempBundlePath)) {
    fs.unlinkSync(tempBundlePath);
  }
}

const obfuscatedSize = fs.statSync(distProtectedBundle).size;
console.log(`   ✓ Obfuscated protected bundle generated: ${(obfuscatedSize / 1024).toFixed(1)} KB`);

// 5. Copy static assets to dist-protected/
console.log('\n📁 Step 3: Mirroring static assets and PWA manifests to dist-protected/...');

const filesToCopy = [
  { from: path.join(ROOT_DIR, 'src', 'styles.css'), to: path.join(distSrcDir, 'styles.css') },
  { from: path.join(ROOT_DIR, 'manifest.json'), to: path.join(DIST_DIR, 'manifest.json') },
  { from: path.join(ROOT_DIR, 'icon-512.png'), to: path.join(DIST_DIR, 'icon-512.png') },
  { from: path.join(ROOT_DIR, 'qr_code.png'), to: path.join(DIST_DIR, 'qr_code.png') }
];

filesToCopy.forEach(({ from, to }) => {
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, to);
    console.log(`   ✓ Copied ${path.basename(to)}`);
  }
});

// 6. Generate production index.html referencing obfuscated bundle
console.log('\n📄 Step 4: Generating production index.html...');
const originalHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf-8');
const protectedHtml = originalHtml.replace(
  /<script\s+type="module"\s+src="\.\/app\.js"><\/script>/i,
  '<script type="module" src="./app.bundle.js"></script>'
);
fs.writeFileSync(path.join(DIST_DIR, 'index.html'), protectedHtml, 'utf-8');
console.log('   ✓ dist-protected/index.html linked to app.bundle.js');

// 7. Generate production service worker (sw.js) with production asset cache
console.log('\n⚙️  Step 5: Generating production service worker (sw.js)...');
const originalSw = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf-8');
const protectedSw = originalSw.replace(
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
fs.writeFileSync(path.join(DIST_DIR, 'sw.js'), protectedSw, 'utf-8');
console.log('   ✓ dist-protected/sw.js configured with single bundle caching');

console.log('\n=============================================================');
console.log('✅ CODE OBFUSCATION & SECURITY HARDENING COMPLETE!');
console.log('=============================================================');
console.log('Protected Outputs:');
console.log(`1. Production Directory: ${DIST_DIR}`);
console.log(`2. Root In-Place Bundle: ${rootProtectedBundle}`);
console.log('\nHow to deploy:');
console.log('• To deploy as a standalone package: Deploy the "dist-protected" folder.');
console.log('• To switch your current root server to obfuscated mode: npm run prod:switch');
console.log('• To switch back to development mode: npm run dev:switch');
console.log('=============================================================\n');

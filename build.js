// @ts-check
const esbuild = require('esbuild');
const fs = require('fs');

const result = esbuild.buildSync({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  write: false,
  minify: false,
});

const bundled = Buffer.from(result.outputFiles[0].contents).toString('utf8');
let html = fs.readFileSync('concept-map.html', 'utf8');

html = html.replace(
  '<script type="module" src="src/main.js"></script>',
  `<script>\n${bundled}\n</script>`
);

// Inline the bundled fonts so the page works offline and stays one file
// (the shared view page is built from it too).
html = html.replace(/url\(fonts\/([\w-]+\.woff2)\)/g, (_, f) =>
  `url(data:font/woff2;base64,${fs.readFileSync('fonts/' + f).toString('base64')})`);

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/concept-map.html', html);
console.log('✓ Built dist/concept-map.html');

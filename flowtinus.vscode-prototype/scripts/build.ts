// PROTOTYPE (#86): throwaway. Bundles the extension (Node, CommonJS) and the canvas (browser) into out/.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const here = join(import.meta.dir, '..');
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

const extension = await Bun.build({
    entrypoints: [join(here, 'src/extension.ts')],
    outdir: out,
    target: 'node',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: 'inline',
});
const webview = await Bun.build({
    entrypoints: [join(here, 'src/webview/canvas.tsx')],
    outdir: out,
    naming: 'webview.js',
    target: 'browser',
    format: 'esm',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
});
for (const result of [extension, webview]) {
    if (!result.success) {
        console.error(result.logs.join('\n'));
        process.exit(1);
    }
}
copyFileSync(join(dirname(require.resolve('@xyflow/react/package.json')), 'dist/style.css'), join(out, 'xyflow.css'));
copyFileSync(join(here, 'src/webview/webview.css'), join(out, 'webview.css'));
console.log('built out/extension.js, out/webview.js');
if (Bun.spawnSync(['bun', join(here, 'scripts/build-editor.ts')], { stdio: ['inherit', 'inherit', 'inherit'] }).exitCode !== 0) {
    process.exit(1);
}

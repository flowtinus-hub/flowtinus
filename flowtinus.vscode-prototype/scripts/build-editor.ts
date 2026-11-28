// PROTOTYPE (#86): throwaway. Builds the web editor's flow page for the webview with the editor's own Vite, plugins and
// Tailwind (run from the editor's folder, so Tailwind scans its sources): out/editor/editor.js and editor.css.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const here = join(import.meta.dir, '..');
const editor = join(here, '..', 'flowtinus.editor');
const fromEditor = createRequire(join(editor, 'package.json'));
const load = async (name: string) => (await import(fromEditor.resolve(name))) as Record<string, unknown>;

const { build } = (await load('vite')) as { build: (config: unknown) => Promise<unknown> };
const react = (await load('@vitejs/plugin-react')).default as () => unknown;
const tailwind = (await load('@tailwindcss/vite')).default as () => unknown;

process.chdir(editor);
await build({
    root: editor,
    configFile: false,
    logLevel: 'warn',
    plugins: [
        // in a webview the page and its files have different origins: a worker from a URL is refused, one from a blob
        // (worker-src blob:) is not, so Monaco's workers are inlined in the bundle
        {
            name: 'inline-workers',
            enforce: 'pre',
            transform: (code: string, id: string) =>
                id.endsWith('monaco-setup.ts') ? code.replaceAll("?worker'", "?worker&inline'") : undefined,
        },
        react(),
        tailwind(),
    ],
    resolve: {
        dedupe: ['react', 'react-dom'],
        // the entry sits outside the editor: its own imports resolve from the editor's packages
        alias: {
            '@': join(editor, 'src'),
            ...Object.fromEntries(['react-router', 'react-dom', 'react'].map(m => [m, dirname(fromEditor.resolve(`${m}/package.json`))])),
        },
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
        outDir: join(here, 'out', 'editor'),
        emptyOutDir: true,
        cssCodeSplit: false,
        lib: {
            entry: join(here, 'src', 'webview-editor', 'main.tsx'),
            formats: ['es'],
            fileName: () => 'editor.js',
            cssFileName: 'editor',
        },
        rolldownOptions: { output: { codeSplitting: false } },
    },
});
console.log('built out/editor');

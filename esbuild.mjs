import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  // ssh2 optionally loads native crypto bindings; the pure-JS fallback is used when absent.
  external: ['vscode', 'cpu-features', './crypto/build/Release/sshcrypto.node'],
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' }),
  esbuild.context({ ...common, entryPoints: ['src/debug/pipeProxy.ts'], outfile: 'dist/pipeProxy.js' }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}

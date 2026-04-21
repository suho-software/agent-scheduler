import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: { resolve: false },
  tsconfig: 'tsconfig.build.json',
  clean: true,
  sourcemap: true,
});

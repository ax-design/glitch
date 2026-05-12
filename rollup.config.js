import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';

const config = {
    input: ['./src/index.ts'],
    output: {
        file: './build/main.js',
        format: 'umd',
        name: 'AxGlitch',
        sourcemap: true,
    },
    plugins: [
        nodeResolve(),
        typescript({
            outDir: 'build',
            declaration: false,
            declarationMap: false,
        }),
    ],
};

export default config;

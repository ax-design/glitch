import typescript from '@rollup/plugin-typescript';

const config = {
    input: ['./src/index.ts'],
    output: {
        file: './build/main.js',
        format: 'umd',
        name: 'AxGlitch',
        sourcemap: true,
    },
    plugins: [typescript({
        outDir: 'build',
        declaration: false,
        declarationMap: false,
    })],
};

export default config;

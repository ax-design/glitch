import { PngGlitch } from './types.js';
import { Position } from '../../params/Position.js';
import type { Pool } from '../../params/Pool.js';

export class TransposeGlitch extends PngGlitch {
    readonly type = 'transpose';
    readonly targetPool = 'filteredData';
    chunkCount: number;

    constructor(chunkCount?: number) {
        super(new Position(0));
        this.chunkCount = chunkCount ?? 4;
    }

    apply(bytes: Uint8Array, pool: Pool): void {
        const numScanlines = bytes.length - pool.length;
        if (numScanlines <= 1) return;

        const bytesPerRow = pool.length / numScanlines;
        const rawRowBytes = bytesPerRow + 1;

        const n = Math.min(this.chunkCount, bytes.length);
        if (n <= 1) return;

        const chunkSize = Math.floor(bytes.length / n);

        // Build shuffled chunk order (Fisher-Yates)
        const order = Array.from({ length: n }, (_, i) => i);
        for (let i = n - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = order[i];
            order[i] = order[j];
            order[j] = tmp;
        }

        // Byte-level chunk rearrangement (like pnglitch)
        const result = new Uint8Array(bytes.length);
        let offset = 0;
        for (let k = 0; k < n; k++) {
            const idx = order[k];
            const start = idx * chunkSize;
            const end = idx === n - 1 ? bytes.length : start + chunkSize;
            const len = Math.min(end - start, bytes.length - offset);
            result.set(bytes.subarray(start, start + len), offset);
            offset += len;
        }

        // Fix filter type bytes, clamp to valid range 0-4
        for (let s = 0; s < numScanlines; s++) {
            const ftPos = s * rawRowBytes;
            if (result[ftPos] > 4) {
                result[ftPos] = result[ftPos] % 5;
            }
        }

        bytes.set(result);
    }
}

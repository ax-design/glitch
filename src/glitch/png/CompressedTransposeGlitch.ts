import { PngGlitch } from './types.js';
import { Position } from '../../params/Position.js';
import type { Pool } from '../../params/Pool.js';

export class CompressedTransposeGlitch extends PngGlitch {
    readonly type = 'compressedTranspose';
    readonly targetPool = 'compressedData';
    chunkCount: number;

    constructor(chunkCount?: number) {
        super(new Position(0));
        this.chunkCount = chunkCount ?? 4;
    }

    apply(bytes: Uint8Array, pool: Pool): Uint8Array | void {
        if (bytes.length <= 64 || pool.length <= 64) return;

        const payloadLength = bytes.length - 6;
        const segmentStart = 2 + Math.floor(payloadLength * 0.2);
        const segmentEnd = Math.max(segmentStart + 1, 2 + Math.floor(payloadLength * 0.9));

        const data = bytes.subarray(segmentStart, segmentEnd);

        const n = Math.min(this.chunkCount, data.length);
        if (n <= 1) return;

        const chunkSize = Math.floor(data.length / n);

        const order = Array.from({ length: n }, (_, i) => i);
        for (let i = n - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = order[i];
            order[i] = order[j];
            order[j] = tmp;
        }

        const result = new Uint8Array(data.length);
        let offset = 0;
        for (let k = 0; k < n; k++) {
            const idx = order[k];
            const start = idx * chunkSize;
            const end = idx === n - 1 ? data.length : start + chunkSize;
            const len = Math.min(end - start, data.length - offset);
            result.set(data.subarray(start, start + len), offset);
            offset += len;
        }

        bytes.set(result, segmentStart);
    }
}

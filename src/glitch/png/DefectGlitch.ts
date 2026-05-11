import { PngGlitch, PngGlitchLayer } from './types.js';
import { Position } from '../../params/Position.js';
import type { Pool } from '../../params/Pool.js';

export class DefectGlitch extends PngGlitch {
    readonly type = 'defect';
    readonly targetPool = 'filteredData';
    readonly layer = PngGlitchLayer.Filtered;
    count: number;

    constructor(position: Position, count: number) {
        super(position);
        this.count = count;
    }

    apply(bytes: Uint8Array, pool: Pool): void {
        if (pool.length === 0) return;
        const startIdx = this.position.resolve(pool);
        if (startIdx < 0 || startIdx >= bytes.length) return;

        const end = Math.min(startIdx + this.count, bytes.length);
        const removedCount = end - startIdx;
        bytes.copyWithin(startIdx, end, bytes.length);
        for (let i = bytes.length - removedCount; i < bytes.length; i++) {
            bytes[i] = 0;
        }
    }
}

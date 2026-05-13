import { PngGlitch } from './types.js';
import { Position } from '../../params/Position.js';
import { GlitchValue } from '../../params/GlitchValue.js';
import { GlitchValueCollection } from '../../params/GlitchValueCollection.js';
import { DensityValue } from '../../params/DensityValue.js';
import type { Pool } from '../../params/Pool.js';
import { poolAt } from '../../params/Pool.js';

type DefectTarget = GlitchValue | GlitchValueCollection | DensityValue;

export class CompressedDefectGlitch extends PngGlitch {
    readonly type = 'compressedDefect';
    readonly targetPool = 'compressedData';
    val: DefectTarget;

    constructor(position: Position, val: DefectTarget) {
        super(position);
        this.val = val;
    }

    apply(bytes: Uint8Array, pool: Pool): Uint8Array | void {
        if (pool.length <= 64) return;

        const payloadLength = pool.length - 6;
        const safeStart = 2 + Math.floor(payloadLength * 0.2);
        const safeEnd = Math.max(safeStart + 1, 2 + Math.floor(payloadLength * 0.9));
        const safePool = {
            length: safeEnd - safeStart,
            resolve: (i: number) => poolAt(pool, safeStart + i),
        };

        let defectPositions: number[];

        if (this.val instanceof GlitchValue) {
            const byteIndex = this.position.resolve(safePool);
            defectPositions = byteIndex >= 2 && byteIndex < bytes.length - 4 ? [byteIndex] : [];
        } else {
            const baseIdx = Math.floor((this.position.value / 100) * (safePool.length - 1));
            const resolved = this.val.resolve(safePool, baseIdx);
            defectPositions = resolved
                .map((r) => r.byteIndex)
                .filter((idx) => idx >= 2 && idx < bytes.length - 4);
        }

        if (defectPositions.length === 0) return;

        // Delete bytes: shift non-deleted forward within the data section (index 2 to length-5)
        const skipSet = new Set(defectPositions);
        let writeIdx = 2;
        for (let readIdx = 2; readIdx < bytes.length - 4; readIdx++) {
            if (!skipSet.has(readIdx)) {
                bytes[writeIdx++] = bytes[readIdx];
            }
        }

        const footerStart = writeIdx;
        const result = new Uint8Array(footerStart + 4);
        result.set(bytes.subarray(0, footerStart));
        result.set(bytes.subarray(bytes.length - 4), footerStart);
        return result;
    }
}

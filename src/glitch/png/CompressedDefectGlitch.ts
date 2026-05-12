import { PngGlitch } from './types.js';
import { Position } from '../../params/Position.js';
import { GlitchValue } from '../../params/GlitchValue.js';
import { GlitchValueCollection } from '../../params/GlitchValueCollection.js';
import { DensityValue } from '../../params/DensityValue.js';
import type { Pool } from '../../params/Pool.js';

type DefectTarget = GlitchValue | GlitchValueCollection | DensityValue;

export class CompressedDefectGlitch extends PngGlitch {
    readonly type = 'compressedDefect';
    readonly targetPool = 'compressedData';
    val: DefectTarget;

    constructor(position: Position, val: DefectTarget) {
        super(position);
        this.val = val;
    }

    apply(bytes: Uint8Array, pool: Pool): void {
        if (pool.length === 0) return;

        let defectPositions: number[];

        if (this.val instanceof GlitchValue) {
            const byteIndex = this.position.resolve(pool);
            defectPositions = byteIndex >= 0 && byteIndex < bytes.length ? [byteIndex] : [];
        } else {
            const baseIdx = Math.floor((this.position.value / 100) * (pool.length - 1));
            const resolved = this.val.resolve(pool, baseIdx);
            defectPositions = resolved
                .map((r) => r.byteIndex)
                .filter((idx) => idx >= 0 && idx < bytes.length);
        }

        if (defectPositions.length === 0) return;

        // Delete bytes: shift non-deleted forward, zero-fill the end
        const skipSet = new Set(defectPositions);
        let writeIdx = 0;
        for (let readIdx = 0; readIdx < bytes.length; readIdx++) {
            if (!skipSet.has(readIdx)) {
                bytes[writeIdx++] = bytes[readIdx];
            }
        }
        for (let i = writeIdx; i < bytes.length; i++) {
            bytes[i] = 0;
        }
    }
}

import { PngGlitch } from './types.js';
import { Position } from '../../params/Position.js';
import { GlitchValue } from '../../params/GlitchValue.js';
import { GlitchValueCollection } from '../../params/GlitchValueCollection.js';
import { DensityValue } from '../../params/DensityValue.js';
import type { Pool } from '../../params/Pool.js';
import { poolAt } from '../../params/Pool.js';

type ReplaceTarget = GlitchValue | GlitchValueCollection | DensityValue;

export class CompressedReplaceGlitch extends PngGlitch {
    readonly type = 'compressedReplace';
    readonly targetPool = 'compressedData';
    val: ReplaceTarget;

    constructor(position: Position, val: ReplaceTarget) {
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

        if (this.val instanceof GlitchValue) {
            const byteIndex = this.position.resolve(safePool);
            if (byteIndex >= 2 && byteIndex < bytes.length - 4) {
                bytes[byteIndex] = this.val.value;
            }
        } else {
            const baseIdx = Math.floor((this.position.value / 100) * (safePool.length - 1));
            const resolved = this.val.resolve(safePool, baseIdx);
            for (const { byteIndex, value } of resolved) {
                if (byteIndex >= 2 && byteIndex < bytes.length - 4) {
                    bytes[byteIndex] = value;
                }
            }
        }

    }
}

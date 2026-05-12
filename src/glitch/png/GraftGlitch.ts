import { PngGlitch } from './types.js';
import { Position } from '../../params/Position.js';
import { GlitchValue } from '../../params/GlitchValue.js';
import { GlitchValueCollection } from '../../params/GlitchValueCollection.js';
import { DensityValue } from '../../params/DensityValue.js';
import type { Pool } from '../../params/Pool.js';

type GraftTarget = GlitchValue | GlitchValueCollection | DensityValue;

export class GraftGlitch extends PngGlitch {
    readonly type = 'graft';
    readonly targetPool = 'filterTypes';
    val: GraftTarget;

    constructor(position: Position, val: GraftTarget) {
        super(position);
        this.val = val;
    }

    apply(bytes: Uint8Array, pool: Pool): void {
        if (pool.length === 0) return;

        if (this.val instanceof GlitchValue) {
            const byteIndex = this.position.resolve(pool);
            if (byteIndex >= 0 && byteIndex < bytes.length) {
                bytes[byteIndex] = this.val.value % 5;
            }
        } else {
            const baseIdx = Math.floor((this.position.value / 100) * (pool.length - 1));
            const resolved = this.val.resolve(pool, baseIdx);
            for (const { byteIndex, value } of resolved) {
                if (byteIndex >= 0 && byteIndex < bytes.length) {
                    bytes[byteIndex] = value % 5;
                }
            }
        }
    }
}

import { PngGlitch, PngGlitchLayer } from './types.js';
import { Position } from '../../params/Position.js';
import { GlitchValue } from '../../params/GlitchValue.js';
import type { Pool } from '../../params/Pool.js';

export class IdatGlitch extends PngGlitch {
    readonly type = 'idat';
    readonly targetPool = 'compressedData';
    readonly layer = PngGlitchLayer.Compressed;
    val: GlitchValue;

    constructor(position: Position, val: GlitchValue) {
        super(position);
        this.val = val;
    }

    apply(bytes: Uint8Array, pool: Pool): void {
        if (pool.length === 0) return;
        const byteIndex = this.position.resolve(pool);
        if (byteIndex >= 0 && byteIndex < bytes.length) {
            bytes[byteIndex] = this.val.value;
        }
    }
}

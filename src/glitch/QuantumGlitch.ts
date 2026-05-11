import { BaseGlitch } from './BaseGlitch.js';
import { Position } from '../params/Position.js';
import { GlitchValue } from '../params/GlitchValue.js';
import { safeVal } from '../core/JpegBytes.js';

export class QuantumGlitch extends BaseGlitch {
    readonly type = 'quantum';
    readonly targetPool = 'dqt';
    val: GlitchValue;

    constructor(position: Position, val: GlitchValue) {
        super(position);
        this.val = val;
    }

    apply(bytes: Uint8Array, pool: number[]): void {
        if (pool.length === 0) return;
        const byteIndex = this.position.resolve(pool);
        if (byteIndex >= 0 && byteIndex < bytes.length) {
            bytes[byteIndex] = safeVal(this.val.value);
        }
    }
}

import { BaseGlitch } from './BaseGlitch.js';
import { Position } from '../params/Position.js';
import { GlitchValue } from '../params/GlitchValue.js';
import { GlitchValueCollection } from '../params/GlitchValueCollection.js';
import { safeVal } from '../core/JpegBytes.js';

export class HuffmanGlitch extends BaseGlitch {
    readonly type = 'huffman';
    readonly targetPool = 'dht';
    val: GlitchValue | GlitchValueCollection;

    constructor(position: Position, val: GlitchValue | GlitchValueCollection) {
        super(position);
        this.val = val;
    }

    apply(bytes: Uint8Array, pool: number[]): void {
        if (pool.length === 0) return;

        if (this.val instanceof GlitchValue) {
            const byteIndex = this.position.resolve(pool);
            if (byteIndex >= 0 && byteIndex < bytes.length) {
                bytes[byteIndex] = safeVal(this.val.value);
            }
        } else {
            const baseIdx = Math.floor((this.position.value / 100) * (pool.length - 1));
            const resolved = this.val.resolve(pool, baseIdx);
            for (const { byteIndex, value } of resolved) {
                if (byteIndex >= 0 && byteIndex < bytes.length) {
                    bytes[byteIndex] = safeVal(value);
                }
            }
        }
    }
}

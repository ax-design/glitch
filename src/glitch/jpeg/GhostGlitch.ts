import { BaseGlitch } from '../BaseGlitch.js';
import { Position } from '../../params/Position.js';
import { Offset } from '../../params/Offset.js';
import { GlitchValueCollection } from '../../params/GlitchValueCollection.js';
import { safeVal, isSafe } from '../../core/JpegBytes.js';
import type { Pool } from '../../params/Pool.js';
import { poolAt } from '../../params/Pool.js';

export class GhostGlitch extends BaseGlitch {
    readonly type = 'ghost';
    readonly domain = 'jpeg';
    readonly targetPool = 'data';
    offset: Offset;
    val: GlitchValueCollection;

    constructor(position: Position, offset: Offset, val: GlitchValueCollection) {
        super(position);
        this.offset = offset;
        this.val = val;
    }

    apply(bytes: Uint8Array, pool: Pool): void {
        if (pool.length === 0) return;

        const baseIdx = Math.floor((this.position.value / 100) * (pool.length - 1));
        const resolved = this.val.resolve(pool, baseIdx);

        for (const { byteIndex, value } of resolved) {
            const copyLen = 100 + (value % 200);
            let sourceIdx = byteIndex - this.offset.value * 10;
            if (sourceIdx < poolAt(pool, 0)) sourceIdx = poolAt(pool, 0);

            for (let k = 0; k < copyLen; k++) {
                if (byteIndex + k >= bytes.length) break;
                if (sourceIdx + k >= bytes.length) break;
                if (!isSafe(bytes, byteIndex + k)) continue;

                let v = bytes[sourceIdx + k];
                if (v === 0xff) v = 0xfe;
                bytes[byteIndex + k] = v;
            }
        }
    }
}

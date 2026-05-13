import { Position } from '../params/Position.js';
import type { Pool } from '../params/Pool.js';

export type GlitchRandomizeMode = 'val' | 'pos' | 'both' | 'none';

export abstract class BaseGlitch {
    abstract readonly type: string;
    abstract readonly domain: string;
    abstract readonly targetPool: string;
    position: Position;
    randomizeMode: GlitchRandomizeMode = 'both';

    constructor(position: Position) {
        this.position = position;
    }

    abstract apply(bytes: Uint8Array, pool: Pool): Uint8Array | void;
}

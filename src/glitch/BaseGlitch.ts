import { Position } from '../params/Position.js';

export type GlitchRandomizeMode = 'val' | 'pos' | 'both' | 'none';

export abstract class BaseGlitch {
    abstract readonly type: string;
    abstract readonly targetPool: 'data' | 'dqt' | 'sof' | 'dht';
    position: Position;
    randomizeMode: GlitchRandomizeMode = 'none';

    constructor(position: Position) {
        this.position = position;
    }

    abstract apply(bytes: Uint8Array, pool: number[]): void;
}

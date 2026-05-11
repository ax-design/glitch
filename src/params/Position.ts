import type { Pool } from './Pool.js';
import { poolAt } from './Pool.js';

export class Position {
    value: number;

    constructor(value: number) {
        this.value = value;
    }

    resolve(pool: Pool): number {
        if (pool.length === 0) return -1;
        const index = Math.floor((this.value / 100) * (pool.length - 1));
        const clamped = Math.max(0, Math.min(index, pool.length - 1));
        return poolAt(pool, clamped);
    }
}

/**
 * A pool of byte indices that glitches can target.
 *
 * number[]: explicit index mapping (e.g. JPEG marker positions, filter type offsets).
 * VirtualPool: computed mapping, avoiding massive arrays for large images.
 */

export interface VirtualPool {
    readonly length: number;
    resolve(index: number): number;
    readonly scanlineOffsets?: number[];
}

export type Pool = number[] | VirtualPool;

export function poolAt(pool: Pool, index: number): number {
    return Array.isArray(pool) ? pool[index] : pool.resolve(index);
}

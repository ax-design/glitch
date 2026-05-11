import { Range } from './Range.js';

export enum DistributionKind {
    Sequential = 'sequential',
    Random = 'random',
    Uniform = 'uniform',
}

/**
 * Resolve a distribution into concrete pool indices.
 * All returned values are indices into the pool array, NOT byte positions.
 * Callers must do pool[idx] to get actual byte positions.
 */
export function resolveDistribution(
    kind: DistributionKind,
    poolLength: number,
    baseIdx: number,
    count: number,
    spread?: Range<number>,
): number[] {
    const maxIdx = poolLength - 1;
    switch (kind) {
        case DistributionKind.Sequential:
            return Array.from({ length: count }, (_, i) =>
                Math.min(baseIdx + i, maxIdx),
            );

        case DistributionKind.Random: {
            const lo = spread?.min ?? 0;
            const hi = spread?.max ?? maxIdx;
            return Array.from({ length: count }, () => {
                const offset = lo + Math.random() * (hi - lo);
                const idx = Math.round(baseIdx + offset);
                return Math.max(0, Math.min(idx, maxIdx));
            });
        }

        case DistributionKind.Uniform: {
            const step = Math.max(1, Math.floor(poolLength / count));
            return Array.from({ length: count }, (_, i) =>
                Math.min(baseIdx + i * step, maxIdx),
            );
        }
    }
}

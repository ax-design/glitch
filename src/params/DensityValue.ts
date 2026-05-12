import { Range } from './Range.js';
import type { Pool } from './Pool.js';
import { poolAt } from './Pool.js';
import { DistributionKind, resolveDistribution } from './Distribution.js';

export class DensityValue {
    density: number;
    valueRange?: Range<number>;
    spread?: Range<number>;
    private _distribution: DistributionKind;

    constructor(density: number, valueRange?: Range<number>, distribution?: DistributionKind) {
        this.density = Math.max(0, Math.min(1, density));
        this.valueRange = valueRange;
        this.spread = undefined;
        this._distribution = distribution ?? DistributionKind.Random;
    }

    resolve(pool: Pool, baseIdx: number): Array<{ byteIndex: number; value: number }> {
        const count = Math.max(1, Math.floor(pool.length * this.density));
        const poolIndices = resolveDistribution(this._distribution, pool.length, baseIdx, count, this.spread);
        return poolIndices.map((poolIdx) => ({
            byteIndex: poolAt(pool, Math.min(poolIdx, pool.length - 1)),
            value: this._pickValue(),
        }));
    }

    randomize(): void {
        // Values are already randomized in _pickValue on each resolve() call
    }

    private _pickValue(): number {
        if (this.valueRange) {
            const { min, max } = this.valueRange;
            let v = min + Math.floor(Math.random() * (max - min + 1));
            if (v === 0xff) v = 0xfe;
            return v;
        }
        let v = Math.floor(Math.random() * 255);
        if (v === 0xff) v = 0xfe;
        return v;
    }
}

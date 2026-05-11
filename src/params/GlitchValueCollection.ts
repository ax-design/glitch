import { Range } from './Range.js';
import { DistributionKind, resolveDistribution } from './Distribution.js';

export interface ValueEntry {
    value: number;
    positionOffset?: number;
}

export class GlitchValueCollection {
    private _entries: ValueEntry[];
    private _distribution: DistributionKind;

    countRange?: Range;
    valueRange?: Range;
    spread?: Range;

    constructor(entries: ValueEntry[], distribution?: DistributionKind);
    constructor(distribution?: DistributionKind);
    constructor(entriesOrDistribution?: ValueEntry[] | DistributionKind, distribution?: DistributionKind) {
        if (typeof entriesOrDistribution === 'string') {
            this._distribution = entriesOrDistribution ?? DistributionKind.Sequential;
            this._entries = [];
        } else {
            this._entries = entriesOrDistribution ?? [];
            this._distribution = distribution ?? DistributionKind.Sequential;
        }
    }

    get entries(): ReadonlyArray<ValueEntry> {
        return this._entries;
    }

    get distribution(): DistributionKind {
        return this._distribution;
    }

    randomize(): void {
        const lo = this.valueRange?.min ?? 0;
        const hi = this.valueRange?.max ?? 254;

        const countLo = this.countRange?.min ?? this._entries.length;
        const countHi = this.countRange?.max ?? this._entries.length;
        const count = countLo + Math.floor(Math.random() * (countHi - countLo + 1));

        this._entries = Array.from({ length: count }, () => {
            let v = lo + Math.floor(Math.random() * (hi - lo + 1));
            if (v === 0xff) v = 0xfe;
            return { value: v };
        });
    }

    /**
     * Resolve all entries to concrete byte indices and values.
     *
     * @param pool      The safe-byte-index pool for the target segment
     * @param baseIdx   The base pool index (NOT a byte index)
     * @returns         Array of { byteIndex, value } ready for writing to the byte array
     */
    resolve(pool: number[], baseIdx: number): Array<{ byteIndex: number; value: number }> {
        if (this._entries.length === 0) return [];

        const hasManualOffsets = this._entries.some((e) => e.positionOffset !== undefined);

        if (hasManualOffsets && !this.countRange) {
            return this._entries.map((entry) => {
                const offset = entry.positionOffset ?? 0;
                const poolIdx = Math.max(0, Math.min(baseIdx + offset, pool.length - 1));
                return { byteIndex: pool[poolIdx], value: entry.value };
            });
        }

        const poolIndices = resolveDistribution(
            this._distribution,
            pool.length,
            baseIdx,
            this._entries.length,
            this.spread,
        );

        return this._entries.map((entry, i) => ({
            byteIndex: pool[poolIndices[i] ?? pool.length - 1],
            value: entry.value,
        }));
    }
}

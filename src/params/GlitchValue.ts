import { Range } from './Range.js';

export class GlitchValue {
    value: number;

    constructor(value: number) {
        this.value = value === 0xff ? 0xfe : value;
    }

    randomize(range?: Range<number>): void {
        const lo = range?.min ?? 0;
        const hi = range?.max ?? 254;
        let v = lo + Math.floor(Math.random() * (hi - lo + 1));
        if (v === 0xff) v = 0xfe;
        this.value = v;
    }
}

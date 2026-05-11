import { PngGlitch, PngGlitchLayer } from './types.js';
import { Position } from '../../params/Position.js';
import type { FilterFunction } from '../../core/PngProcessor.js';
import type { Range } from '../../params/Range.js';
import type { Pool } from '../../params/Pool.js';

export class CustomFilterGlitch extends PngGlitch {
    readonly type = 'customFilter';
    readonly targetPool = 'filteredData';
    readonly layer = PngGlitchLayer.Filtered;
    encoder: FilterFunction;
    scanlineRange?: Range;

    constructor(encoder: FilterFunction, scanlineRange?: Range) {
        super(new Position(0));
        this.encoder = encoder;
        this.scanlineRange = scanlineRange;
    }

    apply(bytes: Uint8Array, pool: Pool): void {
        // CustomFilterGlitch is handled specially by PngDomain.
        // The domain detects this glitch type and uses the full
        // decode/reencode pipeline instead of direct byte manipulation.
    }
}

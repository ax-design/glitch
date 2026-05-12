import type { DomainAnalysis, DomainState, GlitchDomain } from './types.js';
import type { BaseGlitch } from '../glitch/BaseGlitch.js';
import type { Range } from '../params/Range.js';
import { JpegAnalyzer } from '../core/JpegAnalyzer.js';
import { base64ToBytes } from '../core/JpegBytes.js';

export class JpegDomain implements GlitchDomain {
    readonly id = 'jpeg';
    readonly mimeType = 'image/jpeg';
    quality: number;
    qualityRange?: Range<number>;

    constructor(options?: { quality?: number; qualityRange?: Range<number> }) {
        this.quality = options?.quality ?? 0.95;
        this.qualityRange = options?.qualityRange;
    }

    encode(sourceCanvas: HTMLCanvasElement, options?: Record<string, unknown>): Uint8Array {
        const quality = (options?.quality as number) ?? this.quality;
        const base64 = sourceCanvas.toDataURL('image/jpeg', quality);
        return base64ToBytes(base64);
    }

    prepare(bytes: Uint8Array): DomainState {
        const analysis: DomainAnalysis = JpegAnalyzer.analyze(bytes);
        return { originalBytes: bytes, analysis };
    }

    async generateFrame(state: DomainState, glitches: BaseGlitch[]): Promise<Uint8Array> {
        const bytes = new Uint8Array(state.originalBytes);
        for (const glitch of glitches) {
            const pool = state.analysis[glitch.targetPool];
            if (pool) glitch.apply(bytes, pool);
        }
        return bytes;
    }
}

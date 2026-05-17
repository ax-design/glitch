import type { Pool } from '../params/Pool.js';

export interface DomainAnalysis {
    [poolName: string]: Pool;
}

export interface DomainState {
    originalBytes: Uint8Array;
    analysis: DomainAnalysis;
}

export interface FrameResult {
    bytes: Uint8Array;
    bitmap?: ImageBitmap | HTMLCanvasElement | HTMLVideoElement | OffscreenCanvas | HTMLImageElement;
}

export interface GlitchDomain {
    readonly id: string;
    readonly mimeType: string;
    encode(sourceCanvas: HTMLCanvasElement, options?: Record<string, unknown>): Uint8Array | Promise<Uint8Array>;
    prepare(bytes: Uint8Array): DomainState | Promise<DomainState>;
    generateFrame(state: DomainState, glitches: import('../glitch/BaseGlitch.js').BaseGlitch[]): Promise<Uint8Array | FrameResult>;
}

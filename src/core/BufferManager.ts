import type { GlitchDomain, DomainState } from '../domain/types.js';
import type { BaseGlitch } from '../glitch/BaseGlitch.js';
import { GlitchValue } from '../params/GlitchValue.js';
import { GlitchValueCollection } from '../params/GlitchValueCollection.js';
import { DensityValue } from '../params/DensityValue.js';
import { Position } from '../params/Position.js';

interface Buffer {
    canvas: HTMLCanvasElement;
    playCount: number;
}

export class BufferManager {
    private _buffers: Buffer[] = [];
    private _bufferSize: number;
    private _domains = new Map<string, GlitchDomain>();
    private _domainStates = new Map<string, DomainState>();
    private _domainGlitches = new Map<string, BaseGlitch[]>();
    private _sourceCanvas: HTMLCanvasElement | null = null;
    private _imageWidth = 0;
    private _imageHeight = 0;
    private _running = false;
    private _abortController: AbortController | null = null;
    private _wakeResolver: (() => void) | null = null;
    private _invalidateGeneration = 0;

    constructor(bufferSize: number) {
        this._bufferSize = bufferSize;
    }

    get bufferSize(): number {
        return this._bufferSize;
    }

    set bufferSize(size: number) {
        this._bufferSize = size;
        if (this._hasActiveDomains()) {
            this._recreateBuffers();
        }
    }

    get ready(): boolean {
        return this._hasActiveDomains();
    }

    registerDomain(domain: GlitchDomain): void {
        this._domains.set(domain.id, domain);
    }

    async enableDomain(domainId: string, sourceCanvas: HTMLCanvasElement, width: number, height: number, options?: Record<string, unknown>): Promise<void> {
        const domain = this._domains.get(domainId);
        if (!domain) return;

        this._sourceCanvas = sourceCanvas;
        this._imageWidth = width;
        this._imageHeight = height;

        const bytes = await domain.encode(sourceCanvas, options);
        const state = await domain.prepare(bytes);
        this._domainStates.set(domainId, state);

        if (this._buffers.length === 0) {
            this._recreateBuffers();
        }
    }

    disableDomain(domainId: string): void {
        this._domainStates.delete(domainId);
        this._domainGlitches.delete(domainId);
    }

    setDomainGlitches(domainId: string, glitches: BaseGlitch[]): void {
        this._domainGlitches.set(domainId, glitches);
    }

    private _hasActiveDomains(): boolean {
        return this._domainStates.size > 0;
    }

    private _recreateBuffers(): void {
        this._buffers = Array.from({ length: this._bufferSize }, () => {
            const canvas = document.createElement('canvas');
            canvas.width = this._imageWidth;
            canvas.height = this._imageHeight;
            return { canvas, playCount: 0 };
        });
    }

    async invalidateAll(): Promise<void> {
        if (!this._hasActiveDomains()) return;

        const generation = ++this._invalidateGeneration;

        const results = await Promise.allSettled(
            this._buffers.map(async (buffer) => {
                const frameCanvas = await this._generateGlitchFrame();
                if (this._invalidateGeneration !== generation) return;
                buffer.canvas.width = this._imageWidth;
                buffer.canvas.height = this._imageHeight;
                const ctx = buffer.canvas.getContext('2d')!;
                ctx.drawImage(frameCanvas, 0, 0);
                buffer.playCount = 0;
            }),
        );

        if (this._invalidateGeneration !== generation) {
            throw new Error('superseded');
        }

        for (const r of results) {
            if (r.status === 'rejected') {
                console.warn('Buffer frame generation failed:', r.reason);
            }
        }
    }

    pickFrame(): Buffer | null {
        if (this._buffers.length === 0) return null;

        let minCount = Infinity;
        for (const b of this._buffers) {
            if (b.playCount < minCount) minCount = b.playCount;
        }

        const candidates = this._buffers.filter((b) => b.playCount === minCount);
        const picked = candidates[Math.floor(Math.random() * candidates.length)];
        picked.playCount++;

        this._wake();
        return picked;
    }

    start(): void {
        if (this._running) return;
        this._running = true;
        this._abortController = new AbortController();
        this._renderLoop(this._abortController.signal);
    }

    stop(): void {
        this._running = false;
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
        this._wake();
    }

    private _wake(): void {
        if (this._wakeResolver) {
            this._wakeResolver();
            this._wakeResolver = null;
        }
    }

    private _waitForWake(signal: AbortSignal): Promise<void> {
        return new Promise<void>((resolve) => {
            const onAbort = () => {
                this._wakeResolver = null;
                resolve();
            };
            signal.addEventListener('abort', onAbort, { once: true });
            this._wakeResolver = () => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            };
        });
    }

    private async _renderLoop(signal: AbortSignal): Promise<void> {
        while (this._running && !signal.aborted) {
            const target = this._findReplacementTarget();

            if (!target) {
                await this._waitForWake(signal);
                continue;
            }

            const frameCanvas = await this._generateGlitchFrame();
            const ctx = target.canvas.getContext('2d')!;
            ctx.clearRect(0, 0, target.canvas.width, target.canvas.height);
            ctx.drawImage(frameCanvas, 0, 0);
            target.playCount = 0;

            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
        }
    }

    private _findReplacementTarget(): Buffer | null {
        let maxCount = 0;
        let target: Buffer | null = null;

        for (const buffer of this._buffers) {
            if (buffer.playCount > maxCount) {
                maxCount = buffer.playCount;
                target = buffer;
            }
        }

        return maxCount > 0 ? target : null;
    }

    private _randomizeGlitchParams(glitches: BaseGlitch[]): void {
        for (const glitch of glitches) {
            const mode = glitch.randomizeMode;
            if (mode === 'none') continue;

            if (mode === 'pos' || mode === 'both') {
                glitch.position = new Position(Math.random() * 100);
            }

            if (mode === 'val' || mode === 'both') {
                if ('val' in glitch) {
                    const val = (glitch as any).val;
                    if (val instanceof GlitchValueCollection) {
                        val.randomize();
                    } else if (val instanceof DensityValue) {
                        val.randomize();
                    } else if (val instanceof GlitchValue) {
                        val.randomize();
                    }
                }
            }
        }
    }

    private _pickActiveDomain(): { domain: GlitchDomain; state: DomainState; glitches: BaseGlitch[] } | null {
        const activeIds = [...this._domainStates.keys()];
        if (activeIds.length === 0) return null;

        const domainId = activeIds[Math.floor(Math.random() * activeIds.length)];
        const domain = this._domains.get(domainId);
        const state = this._domainStates.get(domainId);
        const glitches = this._domainGlitches.get(domainId) ?? [];

        if (!domain || !state) return null;
        return { domain, state, glitches };
    }

    private async _generateGlitchFrame(): Promise<HTMLCanvasElement> {
        const selected = this._pickActiveDomain();
        if (!selected) throw new Error('No active domain');

        const { domain, state, glitches } = selected;

        if (glitches.length > 0) {
            this._randomizeGlitchParams(glitches);
        }

        const resultBytes = await domain.generateFrame(state, glitches);

        const blob = new Blob([resultBytes.buffer as ArrayBuffer], { type: domain.mimeType });
        const url = URL.createObjectURL(blob);

        const img = new Image();
        const loaded = await new Promise<boolean>((resolve) => {
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = url;
        });
        URL.revokeObjectURL(url);

        const canvas = document.createElement('canvas');
        canvas.width = this._imageWidth;
        canvas.height = this._imageHeight;

        if (loaded) {
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        }

        return canvas;
    }
}

import { BaseGlitch } from './glitch/BaseGlitch.js';
import { GlitchValue } from './params/GlitchValue.js';
import { GlitchValueCollection } from './params/GlitchValueCollection.js';
import { Range } from './params/Range.js';
import { BufferManager } from './core/BufferManager.js';
import { JpegDomain } from './domain/JpegDomain.js';
import { PngDomain } from './domain/PngDomain.js';

export class GlitchCanvas extends HTMLElement {
    static readonly ElementName = 'glitch-canvas';

    private _root = this.attachShadow({ mode: 'open' });
    private _canvas: HTMLCanvasElement;
    private _bufferManager: BufferManager;
    private _domainGlitches = new Map<string, BaseGlitch[]>();
    private _playing = false;
    private _playbackTimer: number | null = null;
    private _fps = 8;
    private _src = '';
    private _autoplay = false;
    private _quality = 0.95;
    private _sourceCanvas: HTMLCanvasElement | null = null;
    qualityRange?: Range<number>;
    private _imageWidth = 0;
    private _imageHeight = 0;
    private _renderDebounce: number | null = null;

    static get observedAttributes(): string[] {
        return ['src', 'fps', 'buffer-size', 'autoplay', 'quality'];
    }

    constructor() {
        super();
        this._canvas = document.createElement('canvas');
        this._canvas.style.cssText = 'display:block;width:100%;height:100%;image-rendering:pixelated;';
        this._root.innerHTML = '';
        this._root.appendChild(this._canvas);

        const style = document.createElement('style');
        style.textContent = ':host{display:inline-block;}';
        this._root.insertBefore(style, this._canvas);

        this._bufferManager = new BufferManager(4);
        this._bufferManager.registerDomain(new JpegDomain());
        this._bufferManager.registerDomain(new PngDomain());
    }

    connectedCallback(): void {
        if (this._src) {
            this.load(this._src);
        }
    }

    disconnectedCallback(): void {
        this.pause();
    }

    attributeChangedCallback(name: string, oldVal: string, newVal: string): void {
        if (oldVal === newVal) return;

        switch (name) {
            case 'src':
                this._src = newVal;
                if (this.isConnected) this.load(newVal);
                break;
            case 'fps':
                this._fps = parseInt(newVal, 10) || 12;
                break;
            case 'buffer-size':
                this._bufferManager.bufferSize = parseInt(newVal, 10) || 4;
                if (this._bufferManager.ready) {
                    this._bufferManager.invalidateAll();
                }
                break;
            case 'autoplay':
                this._autoplay = newVal !== null;
                if (this._autoplay && this._bufferManager.ready) {
                    this.play();
                }
                break;
            case 'quality':
                this._quality = Math.min(1, Math.max(0.01, parseFloat(newVal) || 0.95));
                if (this.isConnected && this._src) {
                    this.load(this._src);
                }
                break;
        }
    }

    // --- Attributes ---

    get src(): string {
        return this.getAttribute('src') ?? '';
    }

    set src(val: string) {
        this.setAttribute('src', val);
    }

    get fps(): number {
        return this._fps;
    }

    set fps(val: number) {
        this._fps = val;
        this.setAttribute('fps', String(val));
    }

    get bufferSize(): number {
        return this._bufferManager.bufferSize;
    }

    set bufferSize(val: number) {
        this.setAttribute('buffer-size', String(val));
    }

    get autoplay(): boolean {
        return this.hasAttribute('autoplay');
    }

    set autoplay(val: boolean) {
        if (val) {
            this.setAttribute('autoplay', '');
        } else {
            this.removeAttribute('autoplay');
        }
    }

    get quality(): number {
        return this._quality;
    }

    set quality(val: number) {
        this._quality = Math.min(1, Math.max(0.01, val));
        this.setAttribute('quality', String(this._quality));
    }

    // --- Playback ---

    get isPlaying(): boolean {
        return this._playing;
    }

    play(): void {
        if (this._playing) return;
        if (!this._bufferManager.ready) return;
        this._playing = true;
        this._bufferManager.start();
        this._scheduleNextFrame();
    }

    pause(): void {
        if (!this._playing) return;
        this._playing = false;
        this._bufferManager.stop();
        if (this._playbackTimer !== null) {
            clearTimeout(this._playbackTimer);
            this._playbackTimer = null;
        }
    }

    // --- Domain Management ---

    async enableDomain(domainId: string, options?: Record<string, unknown>): Promise<void> {
        if (!this._sourceCanvas) return;
        await this._bufferManager.enableDomain(
            domainId,
            this._sourceCanvas,
            this._imageWidth,
            this._imageHeight,
            options,
        );
        const glitches = this._domainGlitches.get(domainId) ?? [];
        this._bufferManager.setDomainGlitches(domainId, glitches);
    }

    disableDomain(domainId: string): void {
        this._bufferManager.disableDomain(domainId);
    }

    get activeDomains(): string[] {
        // BufferManager doesn't expose this directly, so we track from domainGlitches
        // that have been enabled. For now, return known domain ids that have glitches.
        return [...this._domainGlitches.keys()];
    }

    // --- Image Loading ---

    async load(url: string): Promise<void> {
        let response: Response;
        try {
            response = await fetch(url, { mode: 'cors' });
        } catch (err) {
            if (err instanceof TypeError) {
                throw new Error('Network error fetching image: ' + url);
            }
            throw err;
        }

        if (response.type === 'opaque') {
            throw new Error(
                'CORS error: Cannot access image at ' + url +
                '. The server must include Access-Control-Allow-Origin headers.',
            );
        }

        if (!response.ok) {
            throw new Error(
                'HTTP ' + response.status + ' loading image: ' + url,
            );
        }

        const blob = await response.blob();
        await this._loadFromBlob(blob);
    }

    cloneFrom(element: HTMLCanvasElement | HTMLImageElement | HTMLPictureElement): void {
        if (element instanceof HTMLCanvasElement) {
            this._sourceCanvas = document.createElement('canvas');
            this._sourceCanvas.width = element.width;
            this._sourceCanvas.height = element.height;
            this._sourceCanvas.getContext('2d')!.drawImage(element, 0, 0);
            this._initDefaultDomain();
        } else if (element instanceof HTMLImageElement) {
            this._drawImageToSource(element);
        } else if (element instanceof HTMLPictureElement) {
            const img = element.querySelector('img');
            if (img) {
                this._drawImageToSource(img);
            }
        }
    }

    private _drawImageToSource(img: HTMLImageElement): void {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = img.naturalWidth || img.width;
        tempCanvas.height = img.naturalHeight || img.height;
        const ctx = tempCanvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        this._sourceCanvas = tempCanvas;
        this._initDefaultDomain();
    }

    private async _loadFromBlob(blob: Blob): Promise<void> {
        const img = new Image();
        const url = URL.createObjectURL(blob);

        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('Failed to decode image from blob'));
            img.src = url;
        });
        URL.revokeObjectURL(url);

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = img.naturalWidth;
        tempCanvas.height = img.naturalHeight;
        const ctx = tempCanvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        this._sourceCanvas = tempCanvas;
        this._initDefaultDomain();
    }

    private async _initDefaultDomain(): Promise<void> {
        if (!this._sourceCanvas) return;

        this._imageWidth = this._sourceCanvas.width;
        this._imageHeight = this._sourceCanvas.height;
        this._canvas.width = this._imageWidth;
        this._canvas.height = this._imageHeight;

        await this._bufferManager.enableDomain(
            'jpeg',
            this._sourceCanvas,
            this._imageWidth,
            this._imageHeight,
            { quality: this._quality },
        );

        for (const [domainId, glitches] of this._domainGlitches) {
            this._bufferManager.setDomainGlitches(domainId, glitches);
        }

        this._bufferManager.invalidateAll().then(() => {
            const frame = this._bufferManager.pickFrame();
            if (frame) {
                const ctx = this._canvas.getContext('2d')!;
                ctx.clearRect(0, 0, this._imageWidth, this._imageHeight);
                ctx.drawImage(frame.canvas, 0, 0);
            }

            if (this._autoplay) {
                this.play();
            }
        }).catch((err) => {
            if (err.message !== 'superseded') {
                console.warn('GlitchCanvas setSource render failed:', err);
            }
        });
    }

    // --- Glitch Management ---

    addGlitch(glitch: BaseGlitch, domainId?: string): void {
        const targetDomain = domainId ?? this._resolveDefaultDomain(glitch.domain);
        const list = this._domainGlitches.get(targetDomain) ?? [];
        list.push(glitch);
        this._domainGlitches.set(targetDomain, list);
        this._bufferManager.setDomainGlitches(targetDomain, list);
    }

    removeGlitch(glitch: BaseGlitch, domainId?: string): void {
        const targetDomain = domainId ?? this._resolveDefaultDomain(glitch.domain);
        const list = this._domainGlitches.get(targetDomain);
        if (!list) return;
        const idx = list.indexOf(glitch);
        if (idx >= 0) {
            list.splice(idx, 1);
            this._bufferManager.setDomainGlitches(targetDomain, list);
        }
    }

    setGlitches(glitches: BaseGlitch[], domainId?: string): void {
        if (domainId) {
            this._domainGlitches.set(domainId, [...glitches]);
            this._bufferManager.setDomainGlitches(domainId, [...glitches]);
        } else {
            // Distribute glitches by their domain field
            const byDomain = new Map<string, BaseGlitch[]>();
            for (const g of glitches) {
                const list = byDomain.get(g.domain) ?? [];
                list.push(g);
                byDomain.set(g.domain, list);
            }
            for (const [id, list] of byDomain) {
                this._domainGlitches.set(id, [...list]);
                this._bufferManager.setDomainGlitches(id, [...list]);
            }
        }
    }

    get glitches(): ReadonlyArray<BaseGlitch> {
        const all: BaseGlitch[] = [];
        for (const list of this._domainGlitches.values()) {
            all.push(...list);
        }
        return all;
    }

    private _resolveDefaultDomain(glitchDomain: string): string {
        // If the domain is already active, use it. Otherwise fall back to jpeg.
        const list = this._domainGlitches.get(glitchDomain);
        if (list) return glitchDomain;
        return 'jpeg';
    }

    // --- Randomization ---

    randomize(): void {
        if (this.qualityRange && this._sourceCanvas) {
            const lo = this.qualityRange.min;
            const hi = this.qualityRange.max;
            this._quality = lo + Math.random() * (hi - lo);
            // Re-encode JPEG domain with new quality
            this._bufferManager.enableDomain(
                'jpeg',
                this._sourceCanvas,
                this._imageWidth,
                this._imageHeight,
                { quality: this._quality },
            );
        }

        for (const list of this._domainGlitches.values()) {
            for (const glitch of list) {
                if ('val' in glitch) {
                    const val = (glitch as any).val;
                    if (val instanceof GlitchValueCollection) {
                        val.randomize();
                    } else if (val instanceof GlitchValue) {
                        val.randomize();
                    }
                }
            }
        }
        this.requestRender();
    }

    requestRender(): void {
        if (!this._bufferManager.ready) return;
        if (this._renderDebounce !== null) {
            clearTimeout(this._renderDebounce);
        }
        this._renderDebounce = window.setTimeout(() => {
            this._renderDebounce = null;
            this._bufferManager.invalidateAll().then(() => {
                if (this._playing) return;
                const frame = this._bufferManager.pickFrame();
                if (frame) {
                    const ctx = this._canvas.getContext('2d')!;
                    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
                    ctx.drawImage(frame.canvas, 0, 0);
                }
            }).catch((err) => {
                if (err.message !== 'superseded') {
                    console.warn('GlitchCanvas render failed:', err);
                }
            });
        }, 30);
    }

    download(filename?: string): void {
        const a = document.createElement('a');
        a.download = filename ?? ('glitch_' + Date.now() + '.png');
        a.href = this._canvas.toDataURL('image/png');
        a.click();
    }

    // --- Internal ---

    private _scheduleNextFrame(): void {
        if (!this._playing) return;

        const frame = this._bufferManager.pickFrame();
        if (frame) {
            const ctx = this._canvas.getContext('2d')!;
            ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
            ctx.drawImage(frame.canvas, 0, 0);
        }

        this._playbackTimer = window.setTimeout(
            () => this._scheduleNextFrame(),
            1000 / this._fps,
        );
    }
}

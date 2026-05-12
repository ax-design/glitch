import { BufferManager } from './core/BufferManager.js';
import { JpegDomain } from './domain/JpegDomain.js';
import { DomainHandle } from './DomainHandle.js';
import type { GlitchDomain } from './domain/types.js';

interface PendingDomain {
    id: string;
    handle: DomainHandle;
    domain: GlitchDomain;
    options?: Record<string, unknown>;
}

export class GlitchCanvas extends HTMLElement {
    static readonly ElementName = 'glitch-canvas';

    private _root = this.attachShadow({ mode: 'open' });
    private _canvas: HTMLCanvasElement;
    private _bufferManager: BufferManager;
    private _handles = new Map<string, DomainHandle>();
    private _pendingDomains: PendingDomain[] = [];
    private _nextDomainId = 1;
    private _autoDomain: DomainHandle | null = null;

    /** The auto-created default JPEG domain (null until image loads). */
    get autoDomain(): DomainHandle | null {
        return this._autoDomain;
    }
    private _playing = false;
    private _playbackTimer: number | null = null;
    private _fps = 8;
    private _src = '';
    private _autoplay = false;
    private _sourceCanvas: HTMLCanvasElement | null = null;
    private _imageWidth = 0;
    private _imageHeight = 0;
    private _renderDebounce: number | null = null;
    private _initialized = false;
    private _rendered = false;

    private _emitRendered(): void {
        if (this._rendered) return;
        this._rendered = true;
        this.dispatchEvent(new CustomEvent('glitch-render', { bubbles: true }));
    }
    private _initObserver: IntersectionObserver | null = null;

    static get observedAttributes(): string[] {
        return ['src', 'fps', 'buffer-size', 'autoplay'];
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
    }

    connectedCallback(): void {
        if (this._src) {
            this.load(this._src);
        }
    }

    disconnectedCallback(): void {
        this.pause();
        if (this._initObserver) {
            this._initObserver.disconnect();
            this._initObserver = null;
        }
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

    addDomain(domain: GlitchDomain, options?: Record<string, unknown>): DomainHandle {
        const id = String(this._nextDomainId++);
        const handle = new DomainHandle(id, this._bufferManager, () => this.requestRender());
        this._handles.set(id, handle);

        if (this._sourceCanvas) {
            // Image already loaded, initialize immediately
            this._initDomain(id, handle, domain, options);
        } else {
            // No image yet, queue for initialization
            this._pendingDomains.push({ id, handle, domain, options });
        }

        return handle;
    }

    removeDomain(handle: DomainHandle | string): void {
        const id = typeof handle === 'string' ? handle : handle.id;
        this._handles.delete(id);
        this._bufferManager.removeDomain(id);

        // Also remove from pending if not yet initialized
        this._pendingDomains = this._pendingDomains.filter((p) => p.id !== id);
    }

    get domains(): DomainHandle[] {
        return [...this._handles.values()];
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
            this._scheduleLazyInit();
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
        this._scheduleLazyInit();
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
        this._scheduleLazyInit();
    }

    private _scheduleLazyInit(): void {
        if (!this._sourceCanvas) return;

        this._imageWidth = this._sourceCanvas.width;
        this._imageHeight = this._sourceCanvas.height;
        this._canvas.width = this._imageWidth;
        this._canvas.height = this._imageHeight;

        // Draw the source image as a placeholder
        const ctx = this._canvas.getContext('2d')!;
        ctx.drawImage(this._sourceCanvas, 0, 0);

        // If already initialized (e.g. re-clone), just re-init directly
        if (this._initialized) {
            this._initDefaultDomain();
            return;
        }

        // Set up IntersectionObserver to defer expensive init until visible
        if (this._initObserver) {
            this._initObserver.disconnect();
        }

        this._initObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    if (this._initObserver) {
                        this._initObserver.disconnect();
                        this._initObserver = null;
                    }
                    this._initDefaultDomain();
                }
            }
        }, { rootMargin: '100px' });

        this._initObserver.observe(this);
    }

    private async _initDefaultDomain(): Promise<void> {
        if (!this._sourceCanvas) return;

        this._initialized = true;

        // Flush any domains that were added before image load
        await this._flushPendingDomains();

        // Auto-add JPEG if no domains exist yet
        if (!this._bufferManager.ready) {
            const id = String(this._nextDomainId++);
            const handle = new DomainHandle(id, this._bufferManager, () => this.requestRender());
            this._handles.set(id, handle);
            await this._bufferManager.addDomain(id, new JpegDomain(), this._sourceCanvas, this._imageWidth, this._imageHeight);
            this._autoDomain = handle;
        }

        this._bufferManager.invalidateAll().then(() => {
            const frame = this._bufferManager.pickFrame();
            if (frame) {
                const ctx = this._canvas.getContext('2d')!;
                ctx.clearRect(0, 0, this._imageWidth, this._imageHeight);
                ctx.drawImage(frame.canvas, 0, 0);
            }

            this._emitRendered();

            if (this._autoplay) {
                this.play();
            }
        }).catch((err) => {
            if (err.message !== 'superseded') {
                console.warn('GlitchCanvas setSource render failed:', err);
            }
            this._emitRendered();
        });
    }

    private async _flushPendingDomains(): Promise<void> {
        const pending = this._pendingDomains;
        this._pendingDomains = [];

        for (const { id, handle, domain, options } of pending) {
            await this._initDomain(id, handle, domain, options);
        }
    }

    private async _initDomain(id: string, handle: DomainHandle, domain: GlitchDomain, options?: Record<string, unknown>): Promise<void> {
        await this._bufferManager.addDomain(id, domain, this._sourceCanvas!, this._imageWidth, this._imageHeight, options);
        handle._flush();
    }

    // --- Randomization ---

    randomize(): void {
        for (const handle of this._handles.values()) {
            const glitches = this._bufferManager.getGlitches(handle.id);
            if (glitches.length > 0) {
                this._bufferManager.randomizeGlitchParams(glitches);
            }

            // Quality randomization for JpegDomain
            const domain = this._bufferManager.getDomain(handle.id);
            if (domain instanceof JpegDomain && domain.qualityRange && this._sourceCanvas) {
                domain.quality = domain.qualityRange.min + Math.random() * (domain.qualityRange.max - domain.qualityRange.min);
                this._bufferManager.resetDomain(handle.id, this._sourceCanvas);
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
                this._emitRendered();
            }).catch((err) => {
                if (err.message !== 'superseded') {
                    console.warn('GlitchCanvas render failed:', err);
                }
                this._emitRendered();
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

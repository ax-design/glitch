import type { BaseGlitch } from './glitch/BaseGlitch.js';
import type { BufferManager } from './core/BufferManager.js';

export class DomainHandle {
    readonly id: string;
    private _manager: BufferManager;
    private _onChange: () => void;
    private _pendingGlitches: BaseGlitch[] = [];

    constructor(id: string, manager: BufferManager, onChange: () => void) {
        this.id = id;
        this._manager = manager;
        this._onChange = onChange;
    }

    get glitches(): ReadonlyArray<BaseGlitch> {
        if (this._manager.hasDomain(this.id)) {
            return this._manager.getGlitches(this.id);
        }
        return this._pendingGlitches;
    }

    addGlitch(glitch: BaseGlitch): void {
        if (this._manager.hasDomain(this.id)) {
            this._manager.addGlitch(this.id, glitch);
        } else {
            this._pendingGlitches.push(glitch);
        }
        this._onChange();
    }

    removeGlitch(glitch: BaseGlitch): void {
        if (this._manager.hasDomain(this.id)) {
            this._manager.removeGlitch(this.id, glitch);
        } else {
            const idx = this._pendingGlitches.indexOf(glitch);
            if (idx >= 0) this._pendingGlitches.splice(idx, 1);
        }
        this._onChange();
    }

    setGlitches(glitches: BaseGlitch[]): void {
        if (this._manager.hasDomain(this.id)) {
            this._manager.setDomainGlitches(this.id, glitches);
        } else {
            this._pendingGlitches = [...glitches];
        }
        this._onChange();
    }

    /** Transfer pending glitches to BufferManager after domain is initialized. */
    _flush(): void {
        if (this._pendingGlitches.length > 0) {
            this._manager.setDomainGlitches(this.id, this._pendingGlitches);
            this._pendingGlitches = [];
        }
    }
}

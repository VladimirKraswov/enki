import type { AsrSettings } from './asr';
import { dictationJournal, dictationScope, type DictationSegment, type DictationStorage } from './journal';
import { OVERLAP_MS, VoiceTiming } from './segmenter';
const MIN_FINAL_CLIP_MS = 400;
interface RecorderClip {
    started: number;
    recorder: MediaRecorder;
    segment: DictationSegment;
    writes: Promise<void>;
    done: Promise<void>;
    resolve: () => void;
}
const captures = new Set<SegmentedCapture>();
export const activeDictationSegments = () => new Set([...captures].flatMap(c => c.ids()));
/** Updates/normal quit await audio persistence, never an ASR network roundtrip. */
export async function flushDictationCapture() { await Promise.all([...captures].map(c => c.finish())); await dictationJournal.flush(); }
export interface CaptureCallbacks {
    ready?(): void;
    progress(seconds: number, level: number, vadAvailable: boolean): void;
    segmentReady(): void;
    stopped(): void;
    error(message: string): void;
}
/** Each clip is a COMPLETE independent recording. MediaRecorder timeslice blobs
 * share container headers and must only be rejoined within the SAME recorder. */
export class SegmentedCapture {
    private clips = new Set<RecorderClip>();
    private current?: RecorderClip;
    private timer?: ReturnType<typeof setInterval>;
    private overlapTimer?: ReturnType<typeof setTimeout>;
    private analyser?: AnalyserNode;
    private values?: Uint8Array<ArrayBuffer>;
    private ended = false;
    private released = false;
    private checkpointReady = false;
    private ready = false;
    private failing = false;
    private finishing?: Promise<void>;
    private started = Date.now();
    private timing = new VoiceTiming(this.started);
    private sequence = 0;
    private group = crypto.randomUUID();
    constructor(private input: MediaStream, private audio: AudioContext | null, private storage: DictationStorage, private workspace: string, private draft: string, private settings: AsrSettings, private callbacks: CaptureCallbacks) { }
    ids() { return [...this.clips].map(c => c.segment.id); }
    /** `preroll` is audio captured while preparation ran (mic opened but the
     * journal was not ready yet). It becomes the first, already complete segment
     * so the very first words are never lost. */
    start(preroll: readonly Blob[] = []) {
        captures.add(this);
        try {
            if (this.audio) {
                this.analyser = this.audio.createAnalyser();
                this.analyser.fftSize = 1024;
                this.audio.createMediaStreamSource(this.input).connect(this.analyser);
                this.values = new Uint8Array(this.analyser.fftSize);
            }
        }
        catch {
            this.analyser = undefined;
        }
        try {
            const heard = preroll.filter(part => part.size > 0);
            if (heard.length) {
                const segment: RecorderClip = { recorder: { state: 'inactive', stop() { } } as unknown as MediaRecorder,
                    started: this.started, segment: { id: crypto.randomUUID(), group: this.group,
                        scope: dictationScope(this.workspace, this.draft), workspace: this.workspace, draft: this.draft,
                        settings: { ...this.settings }, created: this.started, sequence: this.sequence++, overlap: false,
                        mime: heard[0].type || 'audio/webm', parts: [...heard], complete: true },
                    writes: Promise.resolve(), done: Promise.resolve(undefined), resolve: () => { } };
                segment.writes = Promise.resolve(this.storage.put({ ...segment.segment, parts: [...segment.segment.parts] }))
                    .then(() => { this.checkpointReady = true; this.notifyReady(); })
                    .catch((error: unknown) => this.fail(error));
            }
            this.current = this.create(false);
            this.timer = setInterval(() => this.tick(), 50);
        }
        catch (error) {
            this.release();
            captures.delete(this);
            throw error;
        }
    }
    private create(overlap: boolean) {
        const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(m => MediaRecorder.isTypeSupported(m));
        const recorder = new MediaRecorder(this.input, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
        let resolve!: () => void;
        const clip: RecorderClip = { recorder, started: Date.now(), segment: { id: crypto.randomUUID(), group: this.group,
                scope: dictationScope(this.workspace, this.draft), workspace: this.workspace, draft: this.draft,
                settings: { ...this.settings }, created: this.started, sequence: this.sequence++, overlap,
                mime: recorder.mimeType, parts: [], complete: false }, writes: Promise.resolve(), done: new Promise(r => { resolve = r; }), resolve: () => resolve() };
        this.clips.add(clip);
        const persist = () => {
            const snapshot = { ...clip.segment, parts: [...clip.segment.parts] };
            clip.writes = clip.writes.then(() => this.storage.put(snapshot)).catch(error => this.fail(error));
        };
        recorder.ondataavailable = event => { if (event.data.size) {
            clip.segment.mime = recorder.mimeType || event.data.type;
            clip.segment.parts.push(event.data);
            persist();
            // Show readiness only after the encoder has produced real data and
            // its first checkpoint is safe. Speech can start after this signal.
            void clip.writes.then(() => { if (!this.ended && !this.failing) { this.checkpointReady = true; this.notifyReady(); } });
        } };
        recorder.onerror = () => this.fail(Error('Запись прервана. Сохранённые фрагменты можно восстановить. Проверьте микрофон.'));
        recorder.onstop = () => {
            clip.segment.complete = true;
            persist();
            if (!this.ended && this.current === clip)
                void this.finish();
            void clip.writes.finally(() => {
                this.clips.delete(clip);
                clip.resolve();
                if (!this.failing)
                    this.callbacks.segmentReady();
            });
        };
        try {
            recorder.start(1000);
        }
        catch (error) {
            this.clips.delete(clip);
            clip.resolve();
            throw error;
        }
        return clip;
    }
    private notifyReady() {
        if (this.ready || this.ended || this.failing || !this.checkpointReady) return;
        if (!this.input.getTracks().every(track => track.readyState !== 'ended' && !track.muted)) return;
        this.ready = true;
        this.callbacks.ready?.();
    }
    private tick() {
        if (this.ended)
            return;
        const now = Date.now();
        this.notifyReady();
        if (!this.ready && now - this.started >= 8000) {
            this.fail(Error('Микрофон не начал передавать звук. Проверьте устройство и попробуйте снова.'));
            return;
        }
        let rms: number | null = null;
        if (this.analyser && this.values && this.audio?.state !== 'suspended' && this.audio?.state !== 'closed') {
            this.analyser.getByteTimeDomainData(this.values);
            let sum = 0;
            for (const value of this.values)
                sum += ((value - 128) / 128) ** 2;
            rms = Math.sqrt(sum / this.values.length);
        }
        const state = this.timing.sample(now, rms);
        this.callbacks.progress(Math.floor((now - this.started) / 1000), state.level, rms !== null);
        if (state.stop) {
            void this.finish();
            return;
        }
        if (state.rotate && this.current && !this.overlapTimer) {
            const old = this.current;
            try {
                // Begin the next encoder BEFORE stopping the previous one. A short
                // overlap at forced cuts protects phonemes; pause boundaries need none.
                this.current = this.create(state.overlap);
                this.timing.rotated(now);
                const stop = () => { this.overlapTimer = undefined; if (old.recorder.state === 'recording')
                    old.recorder.stop(); };
                if (state.overlap)
                    this.overlapTimer = setTimeout(stop, OVERLAP_MS);
                else
                    stop();
            }
            catch (error) {
                this.fail(error);
            }
        }
    }
    private fail(error: unknown) {
        if (!this.failing) {
            this.failing = true;
            this.callbacks.error(error instanceof Error ? error.message : String(error));
            void this.finish();
        }
    }
    private release() {
        if (this.released) return;
        this.released = true;
        if (this.timer)
            clearInterval(this.timer);
        if (this.overlapTimer)
            clearTimeout(this.overlapTimer);
        this.timer = undefined;
        this.overlapTimer = undefined;
        this.input.getTracks().forEach(t => t.stop());
        void this.audio?.close().catch(() => { });
    }
    finish(): Promise<void> {
        if (this.finishing)
            return this.finishing;
        this.ended = true;
        if (this.timer)
            clearInterval(this.timer);
        if (this.overlapTimer)
            clearTimeout(this.overlapTimer);
        const clips = [...this.clips];
        const stop = () => {
            for (const clip of clips) {
                if (clip.recorder.state !== 'recording') continue;
                try { clip.recorder.stop(); }
                catch {
                    this.failing = true;
                    this.callbacks.error('Не удалось завершить запись. Сохранённые фрагменты оставлены для восстановления.');
                    void clip.writes.finally(() => clip.resolve());
                }
            }
            this.release();
        };
        // A click just after rotation otherwise produces a header-only/tiny final
        // container. Keep the encoder alive briefly, preserving its actual samples.
        const wait = this.failing ? 0 : Math.max(0, ...clips.filter(c=>c.recorder.state==='recording').map(c=>MIN_FINAL_CLIP_MS-(Date.now()-c.started)));
        const padding = wait > 0 ? setTimeout(stop,wait) : undefined;
        if (!padding) stop();
        let timeout: ReturnType<typeof setTimeout>;
        const deadline = new Promise<void>(resolve => {
            timeout = setTimeout(() => {
                this.failing = true;
                this.callbacks.error('Микрофон не завершил запись. Сохранённые фрагменты оставлены для восстановления.');
                void Promise.all(clips.map(c => c.writes)).then(() => resolve());
            }, 5000);
        });
        this.finishing = Promise.race([Promise.all(clips.map(c => c.done)), deadline]).then(() => {
            clearTimeout(timeout);
            clearTimeout(padding);
            this.release();
            captures.delete(this);
            this.callbacks.stopped();
        });
        return this.finishing;
    }
}

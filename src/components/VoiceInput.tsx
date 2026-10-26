import { useEffect, useRef, useState } from 'react';
import { store } from '../state/store';
import { draftKey } from '../state/prefs';
import { defaultAsr, validateAsr } from '../voice/asr';
import { captureErrorMessage, micUnavailableMessage } from '../voice/captureError';
import { activeDictationSegments, SegmentedCapture } from '../voice/capture';
import { dictationJournal, dictationScope, type DictationSegment } from '../voice/journal';
import { TranscriptionQueue } from '../voice/transcriptionQueue';
import { VoiceWaveform } from './VoiceWaveform';
import { Icon } from './Icon';
type Phase = 'idle' | 'requesting' | 'preparing' | 'recording' | 'transcribing';
export function VoiceInput({ disabled, onActiveChange, draftTarget }: {
    disabled: boolean;
    onActiveChange?: (active: boolean) => void;
    /** Durable scoped input other than the main prompt (e.g. a question answer). */
    draftTarget?: string;
}) {
    const [phase, setPhase] = useState<Phase>('idle');
    const [error, setError] = useState('');
    const [recognitionError, setRecognitionError] = useState('');
    const [seconds, setSeconds] = useState(0);
    const [pending, setPending] = useState<DictationSegment[]>([]);
    const [noVad, setNoVad] = useState(false);
    const level = useRef(0);
    const epoch = useRef(0), alive = useRef(true);
    const capture = useRef<SegmentedCapture | null>(null);
    const audio = useRef<AudioContext | null>(null);
    const queue = useRef<TranscriptionQueue | null>(null);
    const workspace = store.state.prefs.workspaceKey ?? store.state.prefs.endpoint;
    const key = draftTarget ?? draftKey(store.state.activeSessionId, store.state.directory);
    const scope = dictationScope(workspace, key);
    const currentScope = useRef(scope);
    currentScope.current = scope;
    useEffect(() => onActiveChange?.(phase !== 'idle'), [phase, onActiveChange]);
    const refresh = async () => {
        const records = await dictationJournal.list(scope);
        if (alive.current && currentScope.current === scope)
            setPending(records.filter(s => !activeDictationSegments().has(s.id)));
    };
    const processor = () => {
        if (queue.current)
            return queue.current;
        queue.current = new TranscriptionQueue(dictationJournal, scope, {
            append: (segment, text) => store.appendDictation(segment.workspace, segment.draft, text, segment.id),
            tail: segment => {
                const prefs = store.state.prefs;
                return ((prefs.workspaceKey ?? prefs.endpoint) === segment.workspace ? prefs.drafts : prefs.endpointState?.[segment.workspace]?.drafts)?.[segment.draft] ?? '';
            },
        }, message => {
            if (!alive.current || currentScope.current !== scope)
                return;
            setRecognitionError(message ?? '');
            void refresh().catch(e => setError(String(e)));
        });
        return queue.current;
    };
    useEffect(() => {
        alive.current = true;
        void refresh().catch(e => { if (alive.current)
            setError(String(e)); });
        return () => {
            epoch.current++;
            alive.current = false;
            queue.current?.dispose();
            queue.current = null;
            void capture.current?.finish();
            capture.current = null;
            void audio.current?.close().catch(() => { });
            audio.current = null;
        };
        // Captured audio belongs to the original draft; navigating never moves it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope]);
    useEffect(() => { setPhase('idle'); setPending([]); setError(''); setRecognitionError(''); }, [scope]);
    const finish = () => {
        if (capture.current) {
            setPhase('transcribing');
            void capture.current.finish();
        }
    };
    const cancel = () => {
        // Permission cancellation has no audio. Once recording begins, stopping
        // preserves already recognized text and the durable pending audio.
        if (capture.current) {
            finish();
            return;
        }
        epoch.current++;
        queue.current?.dispose();
        queue.current = null;
        void audio.current?.close().catch(() => { });
        audio.current = null;
        setPhase('idle');
        void refresh().catch(e => setError(String(e)));
    };
    const start = async () => {
        const settings = { ...(store.state.prefs.asr ?? defaultAsr) }, problem = validateAsr(settings);
        if (problem) {
            setError(problem);
            store.setUi({ settingsOpen: true });
            return;
        }
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
            setError(micUnavailableMessage());
            return;
        }
        const operation = ++epoch.current, active = () => alive.current && epoch.current === operation && currentScope.current === scope;
        setError(''); setRecognitionError('');
        setSeconds(0); level.current = 0;
        setNoVad(false);
        setPhase('requesting');
        // Resume while still in the user's click gesture; never await WebKit's
        // sometimes unresolved resume promise before starting actual recording.
        let context: AudioContext | null = null;
        try {
            context = new AudioContext();
            audio.current = context;
            void context.resume().catch(() => { });
        }
        catch {
            context = null;
        }
        let stream: MediaStream | null = null;
        let storageReady = false;
        try {
            await dictationJournal.ready();
            storageReady = true;
            const saved = await dictationJournal.list(scope);
            if (saved.length) {
                if (active()) { setPending(saved); setPhase('idle'); setError('Есть сохранённая диктовка. Восстановите её или удалите звук перед новой записью.'); }
                void context?.close().catch(() => {});
                return;
            }
            if (!active()) {
                void context?.close().catch(() => { });
                return;
            }
            stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
            if (!active()) {
                stream.getTracks().forEach(t => t.stop());
                void context?.close().catch(() => { });
                return;
            }
            setPhase('preparing');
            const work = processor();
            const recording = new SegmentedCapture(stream, context, dictationJournal, workspace, key, settings, {
                ready: () => { if (active()) setPhase('recording'); },
                progress: (time, amplitude, vad) => { if (active()) {
                    setSeconds(time);
                    setNoVad(time >= 3 && !vad);
                    level.current = amplitude;
                } },
                segmentReady: () => { void work.drain(); if (active())
                    void refresh().catch(e => setError(String(e))); },
                error: message => { if (active())
                    setError(message); },
                stopped: () => {
                    if (active()) {
                        capture.current = null;
                        audio.current = null;
                        setPhase('transcribing');
                    }
                    void work.drain().finally(() => { if (active()) {
                        setPhase('idle');
                        void refresh().catch(e => setError(String(e)));
                    } });
                },
            });
            capture.current = recording;
            recording.start();
        }
        catch (e) {
            stream?.getTracks().forEach(t => t.stop());
            void context?.close().catch(() => { });
            if (active()) {
                capture.current = null;
                audio.current = null;
                setPhase('idle');
                setError(storageReady ? captureErrorMessage(e) : "Не удалось подготовить локальное хранилище диктовки. Запись не начата.");
            }
        }
    };
    const retry = async () => {
        setError(''); setRecognitionError('');
        try {
            await processor().retry(activeDictationSegments());
            await refresh();
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };
    const discard = async () => {
        if (phase !== 'idle' || !window.confirm('Удалить нераспознанный звук? Готовый текст останется в черновике.'))
            return;
        queue.current?.dispose();
        queue.current = null;
        try {
            for (const segment of pending)
                await dictationJournal.remove(segment.id);
            await refresh();
            setError(''); setRecognitionError('');
        }
        catch (e) {
            setError(String(e));
        }
    };
    const shownError = error || recognitionError;
    const recoverable = pending.length > 0 && (phase === 'idle' || !!shownError);
    return <div className="voice-control">
    {(shownError || recoverable) && <div className={`voice-error ${shownError ? '' : 'voice-saved'}`} role={shownError ? 'alert' : 'status'}>
      {shownError && <><span>{shownError}</span><button onClick={() => {setError('');setRecognitionError('');}} aria-label="Закрыть ошибку микрофона">×</button></>}
      {recoverable && <div className="voice-recovery">
        <span>Сохранённый звук: {pending.length}</span>
        <button type="button" className="btn" onClick={() => void retry()}>Восстановить диктовку</button>
        {phase === 'idle' && <button type="button" className="icon-btn" aria-label="Удалить сохранённую диктовку" onClick={() => void discard()}><Icon name="close"/></button>}
      </div>}
    </div>}
    {phase === 'idle' ? <button className="icon-btn" title="Надиктовать" aria-label="Надиктовать" disabled={disabled || pending.length > 0} onClick={() => void start()}><Icon name="mic"/></button> :
            <div className="voice-recording" role="status" aria-label="Надиктовка">
        <button className="voice-cancel icon-btn" aria-label={phase === 'requesting' || phase === 'preparing' ? 'Отменить диктовку' : phase === 'recording' ? 'Остановить диктовку' : 'Прекратить ожидание распознавания'} title={phase === 'requesting' || phase === 'preparing' ? 'Отменить' : 'Готовый текст и сохранённый звук останутся'} onClick={cancel}><Icon name="close"/></button>
        {phase === 'recording' ? <>
          <VoiceWaveform level={level}/>
          <span className="voice-ready" role="status">Можно говорить</span>
          <span className="voice-timer" title={noVad ? 'Автостоп по тишине недоступен. Остановите запись вручную.' : 'Запись остановится после минуты тишины'}>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>
          <button className="voice-finish icon-btn" aria-label="Закончить и распознать" title="Закончить диктовку" onClick={finish}><Icon name="stop" size={14}/></button>
        </> : <div className="voice-preparing">
          <span className="voice-preparing-bars" aria-hidden="true"><i/><i/><i/><i/><i/></span>
          <span className="voice-preparing-text">
            <b>{phase === 'requesting' ? 'Подключаю микрофон…' : phase === 'preparing' ? 'Готовлю запись…' : 'Распознаю…'}</b>
            <small>{phase === 'transcribing' ? 'Последние фрагменты' : 'Пока не говорите'}</small>
          </span>
        </div>}
      </div>}
  </div>;
}

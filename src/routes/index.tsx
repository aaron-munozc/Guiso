import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { createFileRoute } from '@tanstack/react-router';
import { hexToRgba, parseRgba } from '../lib/color';
import {
  COMBO_OPTIONS,
  PANIC_MODES,
  type ComboMode,
  type ProcessInfo,
  type QueuedProcess,
  type UserSettings,
} from '../lib/types';

export const Route = createFileRoute('/')({
  component: RouteComponent,
});

type Tab = 'targets' | 'action' | 'triggers' | 'appearance';

const TAB_META: { id: Tab; label: string; icon: string; help: string }[] = [
  { id: 'targets', label: 'Kill Targets', icon: '◎', help: 'Choose exactly which processes panic should terminate.' },
  { id: 'action', label: 'Panic Action', icon: '⚡', help: 'Choose the screen disguise and optional companion app.' },
  { id: 'triggers', label: 'Triggers', icon: '⌨', help: 'Configure the global shortcut and emergency gesture.' },
  { id: 'appearance', label: 'Appearance', icon: '◐', help: 'Tune the cover color, blur, animation and timeout.' },
];

function RouteComponent() {
  const [tab, setTab] = useState<Tab>('targets');
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [search, setSearch] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [sessionTargets, setSessionTargets] = useState<QueuedProcess[]>([]);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loadedSnapshot, setLoadedSnapshot] = useState<string>('');
  const [toast, setToast] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isTestingPanic, setIsTestingPanic] = useState(false);
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
  const [gestureScore, setGestureScore] = useState<number | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [gesturePoints, setGesturePoints] = useState<{ x: number; y: number }[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef<{ x: number; y: number }[]>([]);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const settingsFingerprint = useCallback((value: UserSettings) => JSON.stringify(value), []);

  const fetchProcesses = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const list = await invoke<ProcessInfo[]>('get_processes');
      setProcesses(list);
    } catch (error) {
      console.error('[guiso] process scan failed', error);
      showToast('Could not refresh the process list');
    } finally {
      setIsRefreshing(false);
    }
  }, [showToast]);

  const load = useCallback(async () => {
    try {
      const [loaded, queued] = await Promise.all([
        invoke<UserSettings>('get_settings'),
        invoke<QueuedProcess[]>('get_queued_pids'),
      ]);
      setSettings(loaded);
      setLoadedSnapshot(settingsFingerprint(loaded));
      setSessionTargets(queued);
      await fetchProcesses();
    } catch (error) {
      console.error('[guiso] settings load failed', error);
      showToast('Could not load Guiso settings');
    }
  }, [fetchProcesses, settingsFingerprint, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!document.hidden) void fetchProcesses();
    }, 7000);
    return () => window.clearInterval(interval);
  }, [fetchProcesses]);

  const update = useCallback((patch: Partial<UserSettings>) => {
    setSettings((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const dirty = Boolean(settings && settingsFingerprint(settings) !== loadedSnapshot);

  useEffect(() => {
    if (!isRecordingShortcut) return;

    const keyMap: Record<string, string> = {
      ' ': 'SPACE',
      Escape: 'Esc',
      Enter: 'Enter',
      Tab: 'Tab',
      Backspace: 'Backspace',
      Delete: 'Delete',
      Insert: 'Insert',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;

      const parts: string[] = [];
      if (event.ctrlKey || event.metaKey) parts.push('CmdOrCtrl');
      if (event.altKey) parts.push('Alt');
      if (event.shiftKey) parts.push('Shift');

      const key = keyMap[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
      parts.push(key);
      update({ active_shortcut: parts.join('+') });
      setIsRecordingShortcut(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isRecordingShortcut, update]);

  const handleMinimizeToTray = useCallback(async () => {
    try {
      await getCurrentWebviewWindow().hide();
    } catch (error) {
      console.error('[guiso] could not hide to tray', error);
    }
  }, []);

  const toggleSessionTarget = async (process: ProcessInfo) => {
    if (!process.killable) {
      showToast(process.protection_reason ?? 'This process is protected');
      return;
    }

    const queued = sessionTargets.some((item) => item.pid === process.pid);
    try {
      if (queued) {
        await invoke('remove_pid', { pid: process.pid });
        setSessionTargets((items) => items.filter((item) => item.pid !== process.pid));
      } else {
        await invoke('add_pid', { pid: process.pid });
        setSessionTargets((items) => [
          ...items.filter((item) => item.pid !== process.pid),
          {
            pid: process.pid,
            name: process.name,
            start_time: process.start_time,
          },
        ]);
      }
    } catch (error) {
      console.error('[guiso] session target update failed', error);
      showToast(String(error));
    }
  };

  const toggleSavedName = (name: string) => {
    if (!settings) return;
    const normalized = name.trim();
    if (!normalized) return;
    const exists = settings.saved_kill_processes.some(
        (item) => item.toLowerCase() === normalized.toLowerCase(),
    );
    update({
      saved_kill_processes: exists
          ? settings.saved_kill_processes.filter(
              (item) => item.toLowerCase() !== normalized.toLowerCase(),
          )
          : [...settings.saved_kill_processes, normalized],
    });
  };

  const isNameSaved = (name: string) =>
      settings?.saved_kill_processes.some(
          (item) => item.toLowerCase() === name.toLowerCase(),
      ) ?? false;

  const saveSettings = async () => {
    if (!settings) return;
    setIsSaving(true);
    try {
      await invoke('update_settings', { newSettings: settings });
      setLoadedSnapshot(settingsFingerprint(settings));
      showToast('Settings saved and trigger re-armed');
    } catch (error) {
      console.error('[guiso] settings save failed', error);
      showToast(`Could not save settings: ${String(error)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const saveKillList = async () => {
    if (!settings) return;
    try {
      await invoke('save_kill_list', { names: settings.saved_kill_processes });
      setLoadedSnapshot(settingsFingerprint(settings));
      showToast('Persistent kill list saved');
    } catch (error) {
      console.error('[guiso] kill list save failed', error);
      showToast(`Could not save kill list: ${String(error)}`);
    }
  };

  const testPanic = async () => {
    if (!settings) return;
    const confirmed = window.confirm(
        'This runs the real panic path. Configured process targets will be terminated. Continue?',
    );
    if (!confirmed) return;

    setIsTestingPanic(true);
    try {
      await invoke('trigger_panic');
    } catch (error) {
      console.error('[guiso] panic test failed', error);
      showToast(`Panic trigger failed: ${String(error)}`);
    } finally {
      window.setTimeout(() => setIsTestingPanic(false), 1400);
    }
  };

  const canvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const drawCanvasStroke = (points: { x: number; y: number }[]) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#d97706';
    if (points.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.stroke();
  };

  const startDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = canvasPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointsRef.current = [point];
    setGesturePoints([point]);
    setGestureScore(null);
    setIsDrawing(true);
    drawCanvasStroke([point]);
  };

  const continueDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const point = canvasPoint(event);
    if (!point) return;
    const last = pointsRef.current[pointsRef.current.length - 1];
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1) return;
    pointsRef.current.push(point);
    setGesturePoints(pointsRef.current.slice());
    drawCanvasStroke(pointsRef.current);
  };

  const finishDrawing = async (event?: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    setIsDrawing(false);
    if (event && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const points = pointsRef.current.slice();
    if (points.length < 8) {
      showToast('Gesture is too short — draw a more distinct stroke');
      return;
    }

    try {
      await invoke('save_gesture', { rawPoints: points });
      const score = await invoke<number>('test_gesture_score', { rawPoints: points });
      setGestureScore(score);
      showToast('Gesture saved');
    } catch (error) {
      console.error('[guiso] gesture save failed', error);
      showToast(`Could not save gesture: ${String(error)}`);
    }
  };

  const clearGesturePreview = () => {
    pointsRef.current = [];
    setGesturePoints([]);
    setGestureScore(null);
    drawCanvasStroke([]);
  };

  const toggleComboMode = (mode: ComboMode) => {
    if (!settings) return;
    const has = settings.combo_modes.includes(mode);
    let combo = has
        ? settings.combo_modes.filter((item) => item !== mode)
        : [...settings.combo_modes, mode];

    if (!has && (mode === 'youtube' || mode === 'local')) {
      combo = combo.filter((item) => item !== 'youtube' && item !== 'local');
      combo.unshift(mode);
    }
    update({ combo_modes: combo });
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return processes;
    return processes.filter((process) => {
      return (
          process.name.toLowerCase().includes(query) ||
          process.exe_path?.toLowerCase().includes(query)
      );
    });
  }, [processes, search]);

  const savedCount = settings?.saved_kill_processes.length ?? 0;
  const sessionCount = sessionTargets.length;
  const color = settings ? parseRgba(settings.panic_color) : null;
  const selectedMode = settings
      ? PANIC_MODES.find((mode) => mode.id === settings.panic_mode)
      : null;
  const mediaMode = settings?.panic_mode === 'combo'
      ? settings.combo_modes.find((mode) => mode === 'youtube' || mode === 'local')
      : settings?.panic_mode === 'youtube' || settings?.panic_mode === 'local'
          ? settings.panic_mode
          : undefined;

  if (!settings || !color) {
    return (
        <div className="h-screen flex items-center justify-center bg-[#090807] text-stone-400 text-sm">
          Loading Guiso…
        </div>
    );
  }

  return (
      <div className="h-screen flex bg-[#090807] text-stone-200 overflow-hidden select-none">
        <aside className="w-62.5 shrink-0 flex flex-col border-r border-guiso-border bg-[#0f0e0c]">
          <div data-tauri-drag-region className="px-5 pt-6 pb-5 border-b border-guiso-border/70">
            <div className="flex items-center gap-3">
              <img src="/logo_dark.svg" alt="Guiso" className="w-10 h-10 rounded-xl" draggable={false} />
              <div className="min-w-0">
                <h1 className="text-base font-bold tracking-tight text-stone-50">Guiso</h1>
                <p className="text-[10px] text-stone-500 font-semibold uppercase tracking-[0.18em]">Panic Button</p>
              </div>
            </div>
            <div className="mt-5 flex items-center gap-2 rounded-xl border border-emerald-500/15 bg-emerald-500/5 px-3 py-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.55)]" />
              <span className="text-[11px] font-semibold text-emerald-300">ARMED</span>
              <span className="ml-auto text-[10px] text-stone-600">ready</span>
            </div>
          </div>

          <nav className="flex-1 p-3 space-y-1">
            {TAB_META.map((item) => (
                <button
                    key={item.id}
                    type="button"
                    onClick={() => setTab(item.id)}
                    className={`w-full text-left flex items-center gap-3 px-3 py-3 rounded-xl transition-all cursor-pointer border ${
                        tab === item.id
                            ? 'bg-amber-600/12 text-amber-300 border-amber-600/25 shadow-[inset_0_0_24px_rgba(217,119,6,0.035)]'
                            : 'text-stone-400 hover:text-stone-200 hover:bg-[#1a1714] border-transparent'
                    }`}
                >
                  <span className="w-6 text-center text-base opacity-75">{item.icon}</span>
                  <span className="text-sm font-semibold">{item.label}</span>
                </button>
            ))}
          </nav>

          <div className="p-4 border-t border-guiso-border/70 space-y-2">
            <div className="rounded-xl bg-guiso-surface border border-guiso-border p-3 space-y-2">
              <Stat label="Shortcut" value={settings.active_shortcut} mono />
              <Stat label="Persistent" value={`${savedCount}`} />
              <Stat label="Session" value={`${sessionCount}`} />
              <Stat label="Action" value={selectedMode?.label ?? settings.panic_mode} />
            </div>
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0">
          <header data-tauri-drag-region className="shrink-0 flex items-start justify-between gap-4 px-7 py-5 border-b border-guiso-border/70 bg-[#0b0a09]/90">
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-tight text-stone-50">{TAB_META.find((item) => item.id === tab)?.label}</h2>
              <p className="text-xs text-stone-500 mt-1 max-w-2xl">{TAB_META.find((item) => item.id === tab)?.help}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {dirty && <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-amber-500">Unsaved</span>}
              <button
                  type="button"
                  onClick={testPanic}
                  disabled={isTestingPanic}
                  className="px-3.5 py-2 text-xs font-bold rounded-lg bg-red-500/10 border border-red-500/25 text-red-300 hover:bg-red-500/15 transition disabled:opacity-50 cursor-pointer"
              >
                {isTestingPanic ? 'Triggering…' : 'Test Panic'}
              </button>
              <button
                  type="button"
                  onClick={() => void handleMinimizeToTray()}
                  className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-[#181512] border border-guiso-border text-stone-400 hover:text-stone-200 hover:border-stone-600 transition cursor-pointer"
              >
                Hide to Tray
              </button>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto custom-scrollbar p-7">
            {tab === 'targets' && (
                <section className="max-w-5xl space-y-5 animate-fade-in-up">
                  <div className="grid grid-cols-3 gap-3">
                    <SummaryCard title="Persistent" value={savedCount} detail="Matched by exact process name" />
                    <SummaryCard title="Session" value={sessionCount} detail="PID + process start are verified" />
                    <SummaryCard title="Next action" value={selectedMode?.label ?? 'Unknown'} detail="Runs after cleanup succeeds or fails" compact />
                  </div>

                  <div className="flex gap-3">
                    <div className="relative flex-1">
                      <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-600">⌕</span>
                      <input
                          type="text"
                          placeholder="Search process name or executable path…"
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                          className={`${inputClass} pl-9`}
                      />
                    </div>
                    <button type="button" onClick={() => void fetchProcesses()} disabled={isRefreshing} className={secondaryButton}>
                      {isRefreshing ? 'Scanning…' : 'Refresh'}
                    </button>
                  </div>

                  {settings.saved_kill_processes.length > 0 && (
                      <div className="rounded-2xl bg-[#11100e] border border-red-500/15 p-4">
                        <div className="flex items-center justify-between gap-4 mb-3">
                          <div>
                            <p className="text-xs font-bold uppercase tracking-wider text-red-300/90">Persistent targets</p>
                            <p className="text-[10px] text-stone-600 mt-1">Every running instance with these exact names is terminated at panic time.</p>
                          </div>
                          <button type="button" onClick={() => void saveKillList()} className="text-[11px] font-bold text-amber-400 hover:text-amber-300 cursor-pointer">
                            Save targets now
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {settings.saved_kill_processes.map((name) => (
                              <span key={name} className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-red-500/8 border border-red-500/18 text-red-200 text-xs font-medium">
                        {name}
                                <button type="button" aria-label={`Remove ${name}`} onClick={() => toggleSavedName(name)} className="text-red-300/50 hover:text-red-200 cursor-pointer">×</button>
                      </span>
                          ))}
                        </div>
                      </div>
                  )}

                  <div className="rounded-2xl border border-guiso-border overflow-hidden bg-[#12110f] shadow-xl shadow-black/10">
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] px-4 py-2.5 bg-[#171512] border-b border-guiso-border text-[10px] font-bold uppercase tracking-wider text-stone-600">
                      <span>Running processes</span>
                      <span>{filtered.length} shown</span>
                    </div>
                    <div className="max-h-[calc(100vh-380px)] overflow-y-auto custom-scrollbar">
                      {filtered.length === 0 ? (
                          <div className="p-10 text-center">
                            <div className="text-2xl text-stone-700">⌁</div>
                            <p className="mt-2 text-sm text-stone-500">No matching processes</p>
                          </div>
                      ) : filtered.map((process) => {
                        const queued = sessionTargets.some((item) => item.pid === process.pid);
                        const saved = isNameSaved(process.name);
                        return (
                            <div key={process.pid} className="group grid grid-cols-[minmax(0,1fr)_auto] gap-4 items-center px-4 py-3 border-b border-guiso-border/50 hover:bg-[#191613] transition">
                              <div className="flex items-center gap-3 min-w-0">
                                {process.icon ? (
                                    <img src={process.icon} alt="" className="w-9 h-9 rounded-lg object-contain bg-[#0b0a09] border border-guiso-border" />
                                ) : (
                                    <div className="w-9 h-9 rounded-lg bg-[#201d19] border border-guiso-border flex items-center justify-center text-xs text-stone-600">?</div>
                                )}
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <p className="text-sm font-semibold text-stone-200 truncate">{process.name}</p>
                                    {!process.killable && <span className="shrink-0 px-1.5 py-0.5 rounded bg-stone-700/30 text-[9px] font-bold uppercase tracking-wide text-stone-500">Protected</span>}
                                  </div>
                                  <p className="text-[10px] text-stone-600 font-mono truncate max-w-162.5 mt-0.5">PID {process.pid} · {process.memory_mb} MB · {process.cpu_usage.toFixed(1)}% CPU{process.exe_path ? ` · ${process.exe_path}` : ''}</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <button
                                    type="button"
                                    disabled={!process.killable}
                                    title={process.killable ? 'Persist this process name' : process.protection_reason ?? 'Protected process'}
                                    onClick={() => toggleSavedName(process.name)}
                                    className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-bold transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 ${
                                        saved ? 'bg-red-500/12 border-red-500/25 text-red-300' : 'opacity-0 group-hover:opacity-100 bg-[#1d1a17] border-guiso-border text-stone-400 hover:text-stone-200'
                                    }`}
                                >
                                  {saved ? 'Saved' : 'Persist'}
                                </button>
                                <button
                                    type="button"
                                    disabled={!process.killable}
                                    title={process.killable ? 'Queue this exact process instance for the next panic' : process.protection_reason ?? 'Protected process'}
                                    onClick={() => void toggleSessionTarget(process)}
                                    className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-bold transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 ${
                                        queued ? 'bg-amber-600/12 border-amber-600/25 text-amber-300' : 'bg-[#1d1a17] border-guiso-border text-stone-400 hover:text-stone-200'
                                    }`}
                                >
                                  {queued ? 'Queued' : 'Queue'}
                                </button>
                              </div>
                            </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="rounded-xl border border-amber-500/12 bg-amber-500/5 px-4 py-3 text-[10px] leading-relaxed text-stone-500">
                    <span className="font-bold text-amber-300/80">Safety guard:</span> protected operating-system processes and Guiso itself cannot be queued or persisted. Session targets are verified by PID, name and process start time before termination, preventing most PID-reuse mistakes.
                  </div>
                </section>
            )}

            {tab === 'action' && (
                <section className="max-w-4xl space-y-5 animate-fade-in-up">
                  <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
                    {PANIC_MODES.map((mode) => (
                        <button
                            key={mode.id}
                            type="button"
                            onClick={() => update({ panic_mode: mode.id })}
                            className={`text-left p-4 rounded-2xl border transition ${
                                settings.panic_mode === mode.id
                                    ? 'bg-amber-600/9 border-amber-500/35 ring-1 ring-amber-500/15'
                                    : 'bg-[#12110f] border-guiso-border hover:border-stone-700'
                            }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className={`text-sm font-bold ${settings.panic_mode === mode.id ? 'text-amber-300' : 'text-stone-200'}`}>{mode.label}</span>
                            {settings.panic_mode === mode.id && <span className="text-[9px] font-bold uppercase tracking-wider text-amber-500">Selected</span>}
                          </div>
                          <p className="text-[11px] text-stone-500 mt-1.5 leading-relaxed">{mode.desc}</p>
                        </button>
                    ))}
                  </div>

                  {settings.panic_mode === 'combo' && (
                      <div className="rounded-2xl bg-[#12110f] border border-guiso-border p-5 space-y-4">
                        <div>
                          <p className="text-xs font-bold uppercase tracking-wider text-stone-400">Combo actions</p>
                          <p className="text-[10px] text-stone-600 mt-1">One media disguise can be combined with fade, glitch and a companion application.</p>
                        </div>
                        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
                          {COMBO_OPTIONS.map((option) => {
                            const enabled = settings.combo_modes.includes(option.id);
                            return (
                                <button
                                    key={option.id}
                                    type="button"
                                    onClick={() => toggleComboMode(option.id)}
                                    className={`text-left p-3 rounded-xl border transition ${
                                        enabled ? 'bg-amber-600/10 border-amber-500/25' : 'bg-[#181613] border-guiso-border hover:border-stone-700'
                                    }`}
                                >
                                  <div className="flex items-center gap-2">
                                    <span className={`flex h-4 w-4 items-center justify-center rounded border text-[10px] ${enabled ? 'bg-amber-500 border-amber-400 text-black' : 'border-[#3a3530] text-transparent'}`}>✓</span>
                                    <span className={`text-xs font-semibold ${enabled ? 'text-amber-200' : 'text-stone-300'}`}>{option.label}</span>
                                  </div>
                                  <p className="text-[10px] text-stone-600 mt-1.5 pl-6">{option.desc}</p>
                                </button>
                            );
                          })}
                        </div>
                        {settings.combo_modes.length === 0 && (
                            <div className="rounded-lg border border-red-500/15 bg-red-500/5 px-3 py-2 text-[10px] text-red-300/75">
                              No combo actions are enabled. The panic will still clean up processes, but there will be no disguise overlay.
                            </div>
                        )}
                      </div>
                  )}

                  {(settings.panic_mode === 'youtube' || (settings.panic_mode === 'combo' && settings.combo_modes.includes('youtube'))) && (
                      <Field label="YouTube disguise URL" hint="Watch, Shorts, youtu.be, or embed URLs are converted to a fullscreen player.">
                        <input className={inputClass} value={settings.youtube_url} onChange={(event) => update({ youtube_url: event.target.value })} placeholder="https://www.youtube.com/watch?v=…" />
                      </Field>
                  )}

                  {(settings.panic_mode === 'launch_app' || (settings.panic_mode === 'combo' && settings.combo_modes.includes('launch_app'))) && (
                      <Field label="Companion application" hint="Executable path, or a .bat/.cmd file on Windows. It is launched silently after target cleanup.">
                        <input className={inputClass} value={settings.launch_app_path} onChange={(event) => update({ launch_app_path: event.target.value })} placeholder="C:\\path\\to\\app.exe" />
                      </Field>
                  )}

                  {(settings.panic_mode === 'local' || (settings.panic_mode === 'combo' && settings.combo_modes.includes('local'))) && (
                      <div className="rounded-2xl bg-[#12110f] border border-guiso-border p-5 space-y-4">
                        <Field label="Local video file" hint="Absolute path. The overlay uses Tauri's file asset protocol so Windows paths work reliably inside the webview.">
                          <input className={inputClass} value={settings.local_video_path} onChange={(event) => update({ local_video_path: event.target.value })} placeholder="C:\\Videos\\disguise.mp4" />
                        </Field>
                        <div className="grid grid-cols-2 gap-4">
                          <Field label="Window / video title">
                            <input className={inputClass} value={settings.local_video_title} onChange={(event) => update({ local_video_title: event.target.value })} />
                          </Field>
                          <Field label="Start time (seconds)">
                            <input className={inputClass} type="number" min={0} value={settings.local_video_start_time} onChange={(event) => update({ local_video_start_time: Math.max(0, Number.parseInt(event.target.value || '0', 10) || 0) })} />
                          </Field>
                        </div>
                      </div>
                  )}

                  {mediaMode === undefined && settings.panic_mode !== 'launch_app' && (
                      <div className="rounded-xl border border-blue-500/15 bg-blue-500/5 px-4 py-3 text-[10px] text-stone-500">
                        This action is purely visual: it covers the screen after process cleanup and will auto-dismiss when its transient animation completes unless you configure an explicit timeout.
                      </div>
                  )}
                </section>
            )}

            {tab === 'triggers' && (
                <section className="max-w-3xl space-y-5 animate-fade-in-up">
                  <div className="rounded-2xl bg-[#12110f] border border-guiso-border p-5 space-y-4">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wider text-stone-400">Global shortcut</p>
                      <p className="text-[10px] text-stone-600 mt-1">Works even when Guiso is hidden in the tray.</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => setIsRecordingShortcut(true)}
                        className={`w-full px-4 py-4 rounded-xl border text-left font-mono text-sm transition cursor-pointer ${
                            isRecordingShortcut ? 'bg-amber-600/8 border-amber-500/30 text-amber-300 animate-pulse' : 'bg-[#0b0a09] border-guiso-border text-stone-200 hover:border-stone-700'
                        }`}
                    >
                      {isRecordingShortcut ? 'Press the desired key combination…' : settings.active_shortcut}
                    </button>
                    <label className="flex items-center gap-3 rounded-xl border border-guiso-border bg-[#171512] px-3 py-3 cursor-pointer">
                      <input type="checkbox" checked={settings.panic_hotkey_close} onChange={(event) => update({ panic_hotkey_close: event.target.checked })} className="w-4 h-4 accent-amber-600 cursor-pointer" />
                      <div>
                        <p className="text-xs font-semibold text-stone-300">Second shortcut closes the disguise</p>
                        <p className="text-[10px] text-stone-600 mt-0.5">The second trigger never re-runs the kill list when this is enabled.</p>
                      </div>
                    </label>
                  </div>

                  <div className="rounded-2xl bg-[#12110f] border border-guiso-border p-5 space-y-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wider text-stone-400">Mouse gesture</p>
                        <p className="text-[10px] text-stone-600 mt-1">Hold the selected mouse button, draw the stroke, then release that same button.</p>
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={settings.gesture_enabled} onChange={(event) => update({ gesture_enabled: event.target.checked })} className="w-4 h-4 accent-amber-600 cursor-pointer" />
                        <span className="text-xs font-semibold text-stone-400">Enabled</span>
                      </label>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      {(['middle', 'right', 'left'] as const).map((button) => (
                          <button key={button} type="button" onClick={() => update({ gesture_button: button })} className={`px-3 py-2.5 rounded-xl border text-xs font-bold capitalize transition cursor-pointer ${settings.gesture_button === button ? 'bg-amber-600/10 border-amber-500/30 text-amber-300' : 'bg-[#181613] border-guiso-border text-stone-500 hover:border-stone-700'}`}>
                            {button} click
                          </button>
                      ))}
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-stone-500">Recognition tolerance</span>
                        <span className="font-mono text-xs text-stone-300">{settings.gesture_threshold.toFixed(2)}</span>
                      </div>
                      <input type="range" min={0.05} max={0.5} step={0.01} value={settings.gesture_threshold} onChange={(event) => update({ gesture_threshold: Number.parseFloat(event.target.value) })} className="w-full accent-amber-600 cursor-pointer" />
                      <p className="text-[10px] text-stone-600 mt-1">Lower is stricter. 0.15–0.25 is a good starting range.</p>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">Draw the panic gesture</p>
                        {gesturePoints.length > 0 && <button type="button" onClick={clearGesturePreview} className="text-[10px] text-stone-600 hover:text-stone-300 cursor-pointer">Clear canvas</button>}
                      </div>
                      <canvas
                          ref={canvasRef}
                          width={620}
                          height={220}
                          onPointerDown={startDrawing}
                          onPointerMove={continueDrawing}
                          onPointerUp={(event) => void finishDrawing(event)}
                          onPointerCancel={(event) => void finishDrawing(event)}
                          className="w-full bg-[#0b0a09] border border-dashed border-[#332e29] rounded-xl cursor-crosshair touch-none"
                      />
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <p className="text-[10px] text-stone-600">The backend normalizes scale and protects against empty/zero-length strokes.</p>
                        {gestureScore !== null && <p className="text-[10px] font-mono text-stone-400">Score {gestureScore.toFixed(4)} · lower is better</p>}
                      </div>
                    </div>
                  </div>
                </section>
            )}

            {tab === 'appearance' && (
                <section className="max-w-3xl space-y-5 animate-fade-in-up">
                  <div className="rounded-2xl bg-[#12110f] border border-guiso-border p-5 space-y-4">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wider text-stone-400">Overlay backdrop</p>
                      <p className="text-[10px] text-stone-600 mt-1">The cover remains opaque enough to hide the desktop while media layers sit above it.</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="relative w-14 h-12 rounded-xl overflow-hidden border border-guiso-border shrink-0">
                        <input type="color" value={color.hex} onChange={(event) => update({ panic_color: hexToRgba(event.target.value, color.alpha) })} className="absolute -inset-2 w-[150%] h-[150%] cursor-pointer" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between text-xs text-stone-500 mb-1.5">
                          <span>Opacity</span>
                          <span className="font-mono text-stone-300">{Math.round(color.alpha * 100)}%</span>
                        </div>
                        <input type="range" min={0} max={1} step={0.01} value={color.alpha} onChange={(event) => update({ panic_color: hexToRgba(color.hex, Number.parseFloat(event.target.value)) })} className="w-full accent-amber-600 cursor-pointer" />
                      </div>
                    </div>
                    <div className="h-24 rounded-xl border border-guiso-border overflow-hidden" style={{ backgroundColor: settings.panic_color, backdropFilter: `blur(${settings.panic_blur_px}px)` }}>
                      <div className="h-full flex items-end p-3 text-[10px] text-white/40">Panic cover preview</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Blur strength (px)" hint="0–80 px">
                      <input className={inputClass} type="number" min={0} max={80} value={settings.panic_blur_px} onChange={(event) => update({ panic_blur_px: Math.min(80, Math.max(0, Number.parseInt(event.target.value || '0', 10) || 0)) })} />
                    </Field>
                    <Field label="Fade-in duration (ms)" hint="0–5000 ms">
                      <input className={inputClass} type="number" min={0} max={5000} value={settings.panic_fade_ms} onChange={(event) => update({ panic_fade_ms: Math.min(5000, Math.max(0, Number.parseInt(event.target.value || '0', 10) || 0)) })} />
                    </Field>
                  </div>

                  <Field label="Auto-close overlay (ms)" hint="0 = media disguises stay open; transient fade/glitch actions still have a safe default lifetime.">
                    <input className={inputClass} type="number" min={0} value={settings.panic_auto_close_ms} onChange={(event) => update({ panic_auto_close_ms: Math.max(0, Number.parseInt(event.target.value || '0', 10) || 0) })} />
                  </Field>

                  <div className="rounded-xl border border-blue-500/12 bg-blue-500/5 px-4 py-3 text-[10px] leading-relaxed text-stone-500">
                    <span className="font-semibold text-blue-300/70">Dismissal:</span> Escape or the close button only closes the disguise; it never re-executes process cleanup. The configured panic shortcut can also close the overlay when the toggle above is enabled.
                  </div>
                </section>
            )}
          </main>

          <footer className="shrink-0 flex items-center justify-between gap-4 px-7 py-3 border-t border-guiso-border/70 bg-[#0f0e0c]">
            <p className="text-[10px] text-stone-600">Cleanup runs first. Only then does the disguise open. Failed process termination is logged and never blocks the disguise.</p>
            <button type="button" onClick={() => void saveSettings()} disabled={isSaving || !dirty} className="px-5 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-stone-950 text-xs font-black transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
              {isSaving ? 'Saving…' : dirty ? 'Save Settings' : 'Saved'}
            </button>
          </footer>
        </div>

        {toast && (
            <div className="fixed left-1/2 bottom-6 -translate-x-1/2 z-100 max-w-lg px-4 py-3 rounded-xl bg-[#1b1815] border border-[#3b342e] text-xs font-semibold text-stone-200 shadow-2xl animate-fade-in-up">
              {toast}
            </div>
        )}
      </div>
  );
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
      <div className="flex items-center justify-between gap-3 text-[10px]">
        <span className="text-stone-600">{label}</span>
        <span className={`text-stone-300 truncate max-w-36.25 ${mono ? 'font-mono text-amber-500/80' : ''}`}>{value}</span>
      </div>
  );
}

function SummaryCard({ title, value, detail, compact = false }: { title: string; value: string | number; detail: string; compact?: boolean }) {
  return (
      <div className="rounded-2xl bg-[#12110f] border border-guiso-border p-4">
        <p className="text-[10px] font-bold uppercase tracking-wider text-stone-600">{title}</p>
        <p className={`mt-1 font-bold text-stone-100 ${compact ? 'text-sm truncate' : 'text-2xl'}`}>{value}</p>
        <p className="mt-1 text-[10px] text-stone-600 leading-relaxed">{detail}</p>
      </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
      <div className="space-y-1.5">
        <label className="block text-xs font-bold text-stone-400">{label}</label>
        {children}
        {hint && <p className="text-[10px] text-stone-600 leading-relaxed">{hint}</p>}
      </div>
  );
}

const secondaryButton = 'px-4 py-2.5 rounded-lg bg-[#181512] border border-guiso-border text-xs font-bold text-stone-400 hover:text-stone-200 hover:border-stone-700 transition cursor-pointer disabled:opacity-50';
const inputClass = 'w-full px-4 py-2.5 rounded-xl bg-[#0b0a09] border border-guiso-border text-sm text-stone-200 placeholder-stone-700 focus:outline-none focus:border-amber-600/45 focus:ring-1 focus:ring-amber-600/15 select-text';
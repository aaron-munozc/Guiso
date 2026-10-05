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

type Tab = 'overview' | 'targets' | 'action' | 'triggers' | 'appearance';

const TABS: { id: Tab; label: string; eyebrow: string; icon: string; help: string }[] = [
  { id: 'overview', label: 'Overview', eyebrow: '01', icon: '⌂', help: 'See exactly what Guiso will do and whether the current setup is ready.' },
  { id: 'targets', label: 'Kill Targets', eyebrow: '02', icon: '◎', help: 'Choose exactly which processes the panic action is allowed to terminate.' },
  { id: 'action', label: 'Panic Action', eyebrow: '03', icon: '⚡', help: 'Choose what happens immediately after cleanup: video, cover, glitch, app launch, or a combination.' },
  { id: 'triggers', label: 'Triggers', eyebrow: '04', icon: '⌨', help: 'Configure the global shortcut, recovery shortcut, and optional mouse gesture.' },
  { id: 'appearance', label: 'Appearance', eyebrow: '05', icon: '◐', help: 'Tune the panic screen visuals and interface behavior.' },
];

const RESCUE_SHORTCUT = 'CmdOrCtrl+Alt+Escape';

const inputClass =
  'w-full rounded-xl border border-guiso-border bg-guiso-panel-strong px-3.5 py-2.75 text-sm text-stone-200 outline-none transition placeholder:text-stone-700 focus:border-amber-500/45 focus:ring-2 focus:ring-amber-500/10 select-text';
const secondaryButton =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-guiso-border bg-guiso-panel-strong px-3.5 py-2.5 text-xs font-bold text-stone-400 transition hover:border-stone-700 hover:text-stone-200 disabled:cursor-not-allowed disabled:opacity-45';
const primaryButton =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-xs font-black text-stone-950 shadow-lg shadow-amber-950/20 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-45';

function selectedModeLabel(settings: UserSettings): string {
  if (settings.panic_mode !== 'combo') {
    return PANIC_MODES.find((mode) => mode.id === settings.panic_mode)?.label ?? settings.panic_mode;
  }
  if (settings.combo_modes.length === 0) return 'No action selected';
  const labels = settings.combo_modes.map((id) => COMBO_OPTIONS.find((option) => option.id === id)?.label ?? id);
  return labels.join(' + ');
}

function RouteComponent() {
  const [tab, setTab] = useState<Tab>('targets');
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [search, setSearch] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [sessionTargets, setSessionTargets] = useState<QueuedProcess[]>([]);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loadedSnapshot, setLoadedSnapshot] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isTestingPanic, setIsTestingPanic] = useState(false);
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
  const [gestureScore, setGestureScore] = useState<number | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [gesturePoints, setGesturePoints] = useState<{ x: number; y: number }[]>([]);
  const [firstLoad, setFirstLoad] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef<{ x: number; y: number }[]>([]);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  const fingerprint = useCallback((value: UserSettings) => JSON.stringify(value), []);

  const fetchProcesses = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const list = await invoke<ProcessInfo[]>('get_processes');
      setProcesses(list);
    } catch (error) {
      console.error('[guiso] process scan failed', error);
      showToast('Could not refresh the process list.');
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
      setLoadedSnapshot(fingerprint(loaded));
      setSessionTargets(queued);
      await fetchProcesses();
    } catch (error) {
      console.error('[guiso] settings load failed', error);
      showToast('Could not load Guiso settings.');
    } finally {
      setFirstLoad(false);
    }
  }, [fetchProcesses, fingerprint, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!document.hidden) void fetchProcesses();
    }, 8000);
    return () => window.clearInterval(interval);
  }, [fetchProcesses]);

  const update = useCallback((patch: Partial<UserSettings>) => {
    setSettings((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const dirty = Boolean(settings && fingerprint(settings) !== loadedSnapshot);

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
      if (event.key === 'Escape') {
        setIsRecordingShortcut(false);
        return;
      }
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
      showToast('Could not hide Guiso to the tray.');
    }
  }, [showToast]);

  const toggleSessionTarget = async (process: ProcessInfo) => {
    if (!process.killable) {
      showToast(process.protection_reason ?? 'This process is protected.');
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
          { pid: process.pid, name: process.name, start_time: process.start_time },
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
        ? settings.saved_kill_processes.filter((item) => item.toLowerCase() !== normalized.toLowerCase())
        : [...settings.saved_kill_processes, normalized],
    });
  };

  const isNameSaved = (name: string) =>
    settings?.saved_kill_processes.some((item) => item.toLowerCase() === name.toLowerCase()) ?? false;

  const saveSettings = async () => {
    if (!settings) return;
    setIsSaving(true);
    try {
      await invoke('update_settings', { newSettings: settings });
      const saved = await invoke<UserSettings>('get_settings');
      setSettings(saved);
      setLoadedSnapshot(fingerprint(saved));
      showToast('Settings saved. Panic trigger re-armed.');
    } catch (error) {
      console.error('[guiso] settings save failed', error);
      showToast(`Could not save settings: ${String(error)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const discardChanges = () => {
    try {
      const original = JSON.parse(loadedSnapshot) as UserSettings;
      setSettings(original);
      setIsRecordingShortcut(false);
      showToast('Unsaved changes discarded.');
    } catch {
      showToast('Could not restore the saved snapshot.');
    }
  };

  const saveKillList = async () => {
    if (!settings) return;
    try {
      await invoke('save_kill_list', { names: settings.saved_kill_processes });
      const saved = await invoke<UserSettings>('get_settings');
      setSettings(saved);
      setLoadedSnapshot(fingerprint(saved));
      showToast('Persistent kill list saved.');
    } catch (error) {
      console.error('[guiso] kill list save failed', error);
      showToast(`Could not save kill list: ${String(error)}`);
    }
  };

  const configurationIssues = useMemo(() => {
    if (!settings) return [];
    const issues: string[] = [];
    const selected = settings.panic_mode === 'combo' ? settings.combo_modes : [settings.panic_mode];
    if (selected.includes('youtube') && !settings.youtube_url.trim()) issues.push('Add a YouTube URL.');
    if (selected.includes('local') && !settings.local_video_path.trim()) issues.push('Choose a local video file.');
    if (selected.includes('launch_app') && !settings.launch_app_path.trim()) issues.push('Choose a companion application.');
    if (settings.panic_mode === 'combo' && settings.combo_modes.length === 0) issues.push('Select at least one combo action.');
    if (settings.active_shortcut === RESCUE_SHORTCUT) issues.push('Choose a primary shortcut other than the reserved recovery shortcut.');
    return issues;
  }, [settings]);

  const panicReady = configurationIssues.length === 0;

  const previewPanic = async () => {
    if (!settings || dirty) {
      showToast('Save your changes before previewing the saved panic configuration.');
      return;
    }
    try {
      await invoke('preview_panic');
      showToast('Preview opened. No processes were terminated and no companion app was launched.');
    } catch (error) {
      showToast(`Preview unavailable: ${String(error)}`);
    }
  };

  const testPanic = async () => {
    if (!settings) return;
    if (dirty) {
      showToast('Save your changes before running the real panic test.');
      return;
    }
    if (!panicReady) {
      showToast(`Setup needs attention: ${configurationIssues[0]}`);
      return;
    }
    const confirmed = window.confirm(
      `Run the real panic test?\n\n${savedCount} persistent target(s) + ${sessionCount} session target(s) may be terminated.\nThen Guiso will run: ${selectedModeLabel(settings)}.\n\nThis is a real cleanup test.`
    );
    if (!confirmed) return;

    setIsTestingPanic(true);
    try {
      await invoke('trigger_panic');
    } catch (error) {
      console.error('[guiso] panic test failed', error);
      showToast(`Panic trigger failed: ${String(error)}`);
    } finally {
      window.setTimeout(() => setIsTestingPanic(false), 1600);
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
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#f59e0b';
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
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1.2) return;
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
      showToast('Gesture is too short. Draw a clearer stroke.');
      return;
    }

    try {
      await invoke('save_gesture', { rawPoints: points });
      const score = await invoke<number>('test_gesture_score', { rawPoints: points });
      const saved = await invoke<UserSettings>('get_settings');
      setSettings(saved);
      setLoadedSnapshot(fingerprint(saved));
      setGestureScore(score);
      showToast('Gesture saved. Lower score means a closer match.');
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
    let combo = has ? settings.combo_modes.filter((item) => item !== mode) : [...settings.combo_modes, mode];

    if (!has && (mode === 'youtube' || mode === 'local')) {
      combo = combo.filter((item) => item !== 'youtube' && item !== 'local');
      combo.unshift(mode);
    }

    update({ combo_modes: combo });
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return processes;
    return processes.filter(
      (process) => process.name.toLowerCase().includes(query) || process.exe_path?.toLowerCase().includes(query),
    );
  }, [processes, search]);

  const savedCount = settings?.saved_kill_processes.length ?? 0;
  const sessionCount = sessionTargets.length;
  const color = settings ? parseRgba(settings.panic_color) : null;
  const selectedMode = settings ? PANIC_MODES.find((mode) => mode.id === settings.panic_mode) : null;
  const mediaMode = settings?.panic_mode === 'combo'
    ? settings.combo_modes.find((mode) => mode === 'youtube' || mode === 'local')
    : settings?.panic_mode === 'youtube' || settings?.panic_mode === 'local'
      ? settings.panic_mode
      : undefined;

  if (!settings || !color) {
    return <LoadingScreen firstLoad={firstLoad} />;
  }

  const tabMeta = TABS.find((item) => item.id === tab) ?? TABS[0];
  const isDarkDim = settings.theme === 'dim';
  const actionLabel = selectedModeLabel(settings);
  const gestureLabel = settings.gesture_enabled ? `${settings.gesture_button} gesture` : 'Gesture disabled';
  const targetSummary = `${savedCount} persistent + ${sessionCount} session`;
  const selectedModes = settings.panic_mode === 'combo' ? settings.combo_modes : [settings.panic_mode];
  const needsYoutube = selectedModes.includes('youtube');
  const needsLocal = selectedModes.includes('local');
  const needsApp = selectedModes.includes('launch_app');

  return (
    <div className={`h-screen overflow-hidden bg-guiso-bg text-stone-200 ${isDarkDim ? 'theme-dim' : ''}`}>
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_right,rgba(245,158,11,.045),transparent_32%),radial-gradient(circle_at_bottom_left,rgba(120,113,108,.035),transparent_30%)]" />

      <div className="relative flex h-full min-w-0">
        <aside className="flex w-64 shrink-0 flex-col border-r border-guiso-border bg-guiso-sidebar">
          <div data-tauri-drag-region className="border-b border-guiso-border/80 px-5 pb-5 pt-5">
            <div className="flex items-center gap-3">
              <img src="/logo_dark.svg" alt="Guiso" className="h-10 w-10 rounded-xl border border-white/5" draggable={false} />
              <div className="min-w-0">
                <p className="text-lg font-black tracking-tight text-stone-50">Guiso</p>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-stone-600">Panic Button</p>
              </div>
            </div>

            <div className="mt-5 flex items-center gap-2 rounded-2xl border border-emerald-500/15 bg-emerald-500/[0.045] px-3.5 py-3">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/30" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
              </span>
              <span className="text-[11px] font-black tracking-wide text-emerald-300">ARMED</span>
              <span className="ml-auto rounded-md bg-black/15 px-1.5 py-0.5 text-[9px] font-semibold text-stone-600">ready</span>
            </div>
          </div>

          <nav className="flex-1 space-y-1.5 overflow-y-auto p-3 custom-scrollbar" aria-label="Settings sections">
            {TABS.map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`group flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition ${
                    active
                      ? 'border-amber-500/20 bg-amber-500/[0.075] text-amber-200 shadow-[inset_0_0_30px_rgba(245,158,11,.025)]'
                      : 'border-transparent text-stone-500 hover:border-guiso-border/70 hover:bg-guiso-panel hover:text-stone-200'
                  }`}
                >
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-sm ${active ? 'bg-amber-500/10 text-amber-300' : 'bg-stone-900/50 text-stone-600 group-hover:text-stone-400'}`}>
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-xs font-bold">{item.label}</span>
                      <span className="text-[9px] font-mono text-stone-700">{item.eyebrow}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[9px] text-stone-700">{item.help}</span>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="border-t border-guiso-border/80 p-3">
            <div className="rounded-2xl border border-guiso-border bg-guiso-panel/75 p-3.5">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-[9px] font-black uppercase tracking-[0.16em] text-stone-600">Current setup</span>
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400/70" />
              </div>
              <div className="space-y-2">
                <Stat label="Trigger" value={settings.active_shortcut} mono />
                <Stat label="Targets" value={targetSummary} />
                <Stat label="Action" value={actionLabel} />
                <Stat label="Recovery" value="Esc + rescue key" />
              </div>
            </div>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header data-tauri-drag-region className="shrink-0 border-b border-guiso-border/80 bg-guiso-header/95 px-7 py-5 backdrop-blur-xl">
            <div className="flex items-start justify-between gap-5">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[9px] font-black uppercase tracking-[0.2em] text-amber-500/65">
                  <span>Guiso</span>
                  <span className="text-stone-700">/</span>
                  <span>{tabMeta.label}</span>
                </div>
                <h1 className="mt-1.5 text-xl font-black tracking-tight text-stone-50">{tabMeta.label}</h1>
                <p className="mt-1 max-w-3xl text-xs leading-relaxed text-stone-600">{tabMeta.help}</p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {dirty && <span className="mr-1 rounded-full border border-amber-500/15 bg-amber-500/5 px-2.5 py-1 text-[9px] font-black uppercase tracking-wider text-amber-400">Unsaved</span>}
                <button type="button" onClick={() => void previewPanic()} disabled={dirty || isTestingPanic || !panicReady} title={dirty ? 'Save changes first' : !panicReady ? configurationIssues[0] : 'Open a non-destructive preview'} className="inline-flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.055] px-3.5 py-2.5 text-xs font-black text-amber-300 transition hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-40">
                  <span className="text-sm">▷</span>
                  Preview
                </button>
                <button type="button" onClick={() => void testPanic()} disabled={isTestingPanic || dirty || !panicReady} title={dirty ? 'Save changes first' : !panicReady ? configurationIssues[0] : 'Run the real panic flow'} className="inline-flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3.5 py-2.5 text-xs font-black text-red-300 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40">
                  <span className="text-sm">●</span>
                  {isTestingPanic ? 'Triggering…' : 'Test Panic'}
                </button>
                <button type="button" onClick={() => void handleMinimizeToTray()} className={secondaryButton}>
                  <span>↓</span>
                  Hide to Tray
                </button>
              </div>
            </div>
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
            <div className="mx-auto w-full max-w-6xl px-7 py-7">
              {tab === 'overview' && (
                <section className="space-y-5 animate-fade-in-up">
                  <div className={`rounded-3xl border p-5 ${panicReady ? 'border-emerald-500/15 bg-emerald-500/[0.035]' : 'border-amber-500/15 bg-amber-500/[0.03]'}`}>
                    <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${panicReady ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}>{panicReady ? '✓' : '!'}</span>
                          <div>
                            <p className="text-[9px] font-black uppercase tracking-[0.18em] text-stone-600">Panic status</p>
                            <p className={`mt-0.5 text-lg font-black ${panicReady ? 'text-emerald-200' : 'text-amber-200'}`}>{panicReady ? 'Ready to run' : 'Needs attention'}</p>
                          </div>
                        </div>
                        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-stone-400">Guiso follows one predictable recipe: handle your selected targets, open the configured panic action, then stay recoverable with Escape or the dedicated rescue shortcut.</p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button type="button" onClick={() => void previewPanic()} disabled={dirty || isTestingPanic || !panicReady} className={secondaryButton} title={!panicReady ? configurationIssues[0] : dirty ? 'Save changes first' : 'Preview without cleanup'}>Preview</button>
                        <button type="button" onClick={() => void testPanic()} disabled={dirty || isTestingPanic || !panicReady} className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-500/20 bg-red-500/[0.07] px-4 py-2.5 text-xs font-black text-red-300 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40">Run Real Test</button>
                      </div>
                    </div>
                    {configurationIssues.length > 0 && (
                      <div className="mt-5 grid gap-2 sm:grid-cols-2">
                        {configurationIssues.map((issue) => (
                          <div key={issue} className="rounded-xl border border-amber-500/10 bg-black/10 px-3 py-2.5 text-[10px] text-amber-200/70">{issue}</div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                    <div className="rounded-3xl border border-guiso-border bg-guiso-panel/85 p-5">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-[9px] font-black uppercase tracking-[0.18em] text-stone-600">Your panic recipe</p>
                          <p className="mt-1 text-base font-black text-stone-100">{targetSummary} → {actionLabel}</p>
                        </div>
                        <span className="rounded-full border border-amber-500/15 bg-amber-500/[0.04] px-2.5 py-1 text-[8px] font-black uppercase tracking-wider text-amber-300">Ctrl 1–5</span>
                      </div>
                      <div className="mt-5 grid gap-2 md:grid-cols-3">
                        <RecipeStep number="1" title="Cleanup" detail={`${savedCount + sessionCount} target${savedCount + sessionCount === 1 ? '' : 's'} selected`} />
                        <RecipeStep number="2" title="Action" detail={actionLabel} />
                        <RecipeStep number="3" title="Recover" detail="Esc or rescue shortcut" />
                      </div>
                      {savedCount + sessionCount === 0 && (
                        <div className="mt-4 rounded-xl border border-stone-800 bg-black/10 px-3 py-2.5 text-[10px] leading-relaxed text-stone-600">No process targets are configured. That is valid: panic mode can still perform its configured visual action.</div>
                      )}
                    </div>

                    <div className="rounded-3xl border border-guiso-border bg-guiso-panel/85 p-5">
                      <p className="text-[9px] font-black uppercase tracking-[0.18em] text-stone-600">At a glance</p>
                      <div className="mt-4 space-y-3">
                        <PreviewRow label="Primary trigger" value={settings.active_shortcut} />
                        <PreviewRow label="Mouse trigger" value={gestureLabel} />
                        <PreviewRow label="Persistent targets" value={String(savedCount)} />
                        <PreviewRow label="Session targets" value={String(sessionCount)} />
                        <PreviewRow label="Recovery" value="Esc / rescue shortcut" />
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <QuickLink icon="◎" title="Choose targets" detail="Pick processes that panic cleanup should handle." onClick={() => setTab('targets')} />
                    <QuickLink icon="⚡" title="Choose action" detail="Select the media, cover, glitch, or app action." onClick={() => setTab('action')} />
                    <QuickLink icon="⌨" title="Set triggers" detail="Change the hotkey and optional gesture." onClick={() => setTab('triggers')} />
                    <QuickLink icon="◐" title="Tune appearance" detail="Adjust the panic screen and timeout behavior." onClick={() => setTab('appearance')} />
                  </div>

                  <div className="rounded-2xl border border-blue-500/10 bg-blue-500/[0.025] px-4 py-3 text-[10px] leading-relaxed text-stone-600">Changes are local until saved. <span className="font-semibold text-stone-500">Preview</span> never runs cleanup or launches a companion app; <span className="font-semibold text-stone-500">Run Real Test</span> does.</div>
                </section>
              )}

              {tab === 'targets' && (
                <section className="space-y-5 animate-fade-in-up">
                  <div className="grid gap-3 md:grid-cols-3">
                    <SummaryCard title="Always Stop" value={savedCount} detail="Saved process names handled every time." icon="↻" tone="red" />
                    <SummaryCard title="Select Once" value={sessionCount} detail="Exact running instances for the next panic." icon="◉" tone="amber" />
                    <SummaryCard title="Panic action" value={selectedMode?.label ?? 'Unknown'} detail="Runs after target cleanup." icon="⚡" tone="stone" compact />
                  </div>

                  <div className="flex flex-col gap-3 rounded-2xl border border-guiso-border bg-guiso-panel/85 p-3 sm:flex-row">
                    <div className="relative min-w-0 flex-1">
                      <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-stone-700">⌕</span>
                      <input
                        type="text"
                        placeholder="Search process name or executable path…"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        className={`${inputClass} pl-9`}
                      />
                    </div>
                    <button type="button" onClick={() => void fetchProcesses()} disabled={isRefreshing} className={secondaryButton}>
                      <span>{isRefreshing ? '◌' : '↻'}</span>
                      {isRefreshing ? 'Scanning…' : 'Refresh'}
                    </button>
                  </div>

                  {savedCount > 0 && (
                    <div className="rounded-2xl border border-red-500/15 bg-red-500/[0.035] p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="h-2 w-2 rounded-full bg-red-400" />
                            <p className="text-[10px] font-black uppercase tracking-[0.17em] text-red-300/85">Always Stop list</p>
                          </div>
                          <p className="mt-1 text-[10px] leading-relaxed text-stone-600">Every running instance with these names can be handled when panic cleanup starts.</p>
                        </div>
                        <button type="button" onClick={() => void saveKillList()} className="text-[10px] font-black text-amber-400 transition hover:text-amber-300">Save list now →</button>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {settings.saved_kill_processes.map((name) => (
                          <span key={name} className="inline-flex items-center gap-2 rounded-xl border border-red-500/15 bg-black/10 px-2.5 py-1.5 text-xs font-medium text-red-100/85">
                            {name}
                            <button type="button" aria-label={`Remove ${name}`} onClick={() => toggleSavedName(name)} className="text-red-300/45 transition hover:text-red-200">×</button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="overflow-hidden rounded-2xl border border-guiso-border bg-guiso-panel/85 shadow-2xl shadow-black/10">
                    <div className="flex items-center justify-between border-b border-guiso-border bg-guiso-panel-strong/70 px-4 py-3">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-stone-500">Running processes</p>
                        <p className="mt-0.5 text-[9px] text-stone-700">{filtered.length} visible · {processes.length} total</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="rounded-lg bg-red-500/5 px-2 py-1 text-[9px] font-black text-red-300/70">{savedCount} always-stop</span>
                        <span className="rounded-lg bg-amber-500/5 px-2 py-1 text-[9px] font-black text-amber-300/70">{sessionCount} select-once</span>
                      </div>
                    </div>

                    <div className="max-h-[min(55vh,560px)] overflow-y-auto custom-scrollbar">
                      {filtered.length === 0 ? (
                        <div className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
                          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-guiso-border bg-black/10 text-xl text-stone-700">⌁</div>
                          <p className="mt-3 text-sm font-bold text-stone-500">No matching processes</p>
                          <p className="mt-1 max-w-sm text-[10px] leading-relaxed text-stone-700">Try another process name, or clear the search filter with Escape.</p>
                        </div>
                      ) : filtered.map((process) => {
                        const queued = sessionTargets.some((item) => item.pid === process.pid);
                        const saved = isNameSaved(process.name);
                        return (
                          <div key={`${process.pid}-${process.start_time}`} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-guiso-border/55 px-4 py-3 transition last:border-b-0 hover:bg-white/[0.012]">
                            <div className="flex min-w-0 items-center gap-3">
                              {process.icon ? (
                                <img src={process.icon} alt="" className="h-10 w-10 shrink-0 rounded-xl border border-guiso-border bg-black/20 object-contain" />
                              ) : (
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-guiso-border bg-black/20 text-xs text-stone-700">?</div>
                              )}
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="truncate text-sm font-bold text-stone-200">{process.name}</p>
                                  {!process.killable && <span className="shrink-0 rounded-md border border-stone-700/50 bg-stone-800/25 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide text-stone-600">Protected</span>}
                                </div>
                                <p className="mt-0.5 truncate font-mono text-[9px] text-stone-700">
                                  PID {process.pid} · {process.memory_mb} MB · {process.cpu_usage.toFixed(1)}% CPU{process.exe_path ? ` · ${process.exe_path}` : ''}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={!process.killable}
                                title={process.killable ? (saved ? 'Remove this process name from Always Stop' : 'Always stop every running instance with this name') : process.protection_reason ?? 'Protected process'}
                                onClick={() => toggleSavedName(process.name)}
                                className={`rounded-xl border px-2.5 py-2 text-[10px] font-black transition disabled:cursor-not-allowed disabled:opacity-25 ${
                                  saved ? 'border-red-500/20 bg-red-500/7 text-red-300' : 'border-guiso-border bg-guiso-panel-strong text-stone-600 opacity-55 hover:text-stone-300 group-hover:opacity-100'
                                }`}
                              >
                                {saved ? '✓ Always Stop' : 'Always Stop'}
                              </button>
                              <button
                                type="button"
                                disabled={!process.killable}
                                title={process.killable ? (queued ? 'Remove this process instance from the next panic' : 'Select this exact running process for the next panic only') : process.protection_reason ?? 'Protected process'}
                                onClick={() => void toggleSessionTarget(process)}
                                className={`rounded-xl border px-2.5 py-2 text-[10px] font-black transition disabled:cursor-not-allowed disabled:opacity-25 ${
                                  queued ? 'border-amber-500/20 bg-amber-500/8 text-amber-300' : 'border-guiso-border bg-guiso-panel-strong text-stone-600 hover:text-stone-300'
                                }`}
                              >
                                {queued ? '✓ Select Once' : 'Select Once'}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <InfoCard title="Always Stop" icon="↺">
                      Saves a process name permanently. When panic runs, every currently running instance with that name is eligible for cleanup.
                    </InfoCard>
                    <InfoCard title="Select Once" icon="◉">
                      Targets the exact running instance you selected for the next panic. PID, name and start time are checked again before termination.
                    </InfoCard>
                  </div>
                </section>
              )}

              {tab === 'action' && (
                <section className="space-y-5 animate-fade-in-up">
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
                    <div className="space-y-4">
                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {PANIC_MODES.map((mode) => {
                          const active = settings.panic_mode === mode.id;
                          return (
                            <button
                              key={mode.id}
                              type="button"
                              onClick={() => update({ panic_mode: mode.id })}
                              className={`group rounded-2xl border p-4 text-left transition ${
                                active
                                  ? 'border-amber-500/25 bg-amber-500/[0.055] ring-1 ring-amber-500/10'
                                  : 'border-guiso-border bg-guiso-panel/80 hover:border-stone-700 hover:bg-guiso-panel'
                              }`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <span className={`flex h-9 w-9 items-center justify-center rounded-xl text-sm ${active ? 'bg-amber-500/10 text-amber-300' : 'bg-black/15 text-stone-600 group-hover:text-stone-400'}`}>{mode.icon}</span>
                                {active && <span className="rounded-full border border-amber-500/15 bg-amber-500/5 px-2 py-1 text-[8px] font-black uppercase tracking-wider text-amber-400">Selected</span>}
                              </div>
                              <p className={`mt-4 text-sm font-black ${active ? 'text-amber-200' : 'text-stone-200'}`}>{mode.label}</p>
                              <p className="mt-1 text-[10px] leading-relaxed text-stone-600">{mode.desc}</p>
                            </button>
                          );
                        })}
                      </div>

                      {settings.panic_mode === 'combo' && (
                        <div className="rounded-2xl border border-guiso-border bg-guiso-panel/85 p-5">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-stone-500">Combo layers</p>
                              <p className="mt-1 text-[10px] leading-relaxed text-stone-700">Choose one media base plus any useful visual or companion-app layers.</p>
                            </div>
                            <span className="text-[9px] font-mono text-stone-700">{settings.combo_modes.length} enabled</span>
                          </div>
                          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                            {COMBO_OPTIONS.map((option) => {
                              const enabled = settings.combo_modes.includes(option.id);
                              return (
                                <button
                                  key={option.id}
                                  type="button"
                                  onClick={() => toggleComboMode(option.id)}
                                  className={`rounded-xl border p-3 text-left transition ${enabled ? 'border-amber-500/20 bg-amber-500/[0.055]' : 'border-guiso-border bg-guiso-panel-strong hover:border-stone-700'}`}
                                >
                                  <div className="flex items-center gap-2.5">
                                    <span className={`flex h-5 w-5 items-center justify-center rounded-md border text-[10px] ${enabled ? 'border-amber-400 bg-amber-500 text-stone-950' : 'border-stone-700 text-transparent'}`}>✓</span>
                                    <span className={`text-xs font-bold ${enabled ? 'text-amber-200' : 'text-stone-300'}`}>{option.label}</span>
                                  </div>
                                  <p className="mt-2 pl-7 text-[10px] leading-relaxed text-stone-700">{option.desc}</p>
                                </button>
                              );
                            })}
                          </div>
                          {settings.combo_modes.length === 0 && (
                            <div className="mt-3 rounded-xl border border-red-500/15 bg-red-500/[0.035] px-3.5 py-3 text-[10px] leading-relaxed text-red-300/70">
                              No combo layers are enabled. Process cleanup will still run, but there will be no visible disguise.
                            </div>
                          )}
                        </div>
                      )}

                      {needsYoutube && (
                        <Field label="YouTube disguise URL" hint="Watch, Shorts, youtu.be, and embed URLs are normalized to a fullscreen player.">
                          <input className={inputClass} value={settings.youtube_url} onChange={(event) => update({ youtube_url: event.target.value })} placeholder="https://www.youtube.com/watch?v=…" />
                        </Field>
                      )}

                      {needsLocal && (
                        <div className="grid gap-4 rounded-2xl border border-guiso-border bg-guiso-panel/85 p-5 md:grid-cols-2">
                          <div className="md:col-span-2">
                            <Field label="Local video file" hint="Absolute path. The overlay uses Tauri's asset protocol so Windows paths are converted safely for the webview.">
                              <input className={inputClass} value={settings.local_video_path} onChange={(event) => update({ local_video_path: event.target.value })} placeholder="C:\\Videos\\disguise.mp4" />
                            </Field>
                          </div>
                          <Field label="Window / video title">
                            <input className={inputClass} value={settings.local_video_title} onChange={(event) => update({ local_video_title: event.target.value })} placeholder="Video Player" />
                          </Field>
                          <Field label="Start time (seconds)">
                            <input className={inputClass} type="number" min={0} value={settings.local_video_start_time} onChange={(event) => update({ local_video_start_time: Math.max(0, Number.parseInt(event.target.value || '0', 10) || 0) })} />
                          </Field>
                        </div>
                      )}

                      {needsApp && (
                        <Field label="Companion application" hint="Executable path, or a .bat/.cmd file on Windows. It starts after process cleanup.">
                          <input className={inputClass} value={settings.launch_app_path} onChange={(event) => update({ launch_app_path: event.target.value })} placeholder="C:\\Path\\to\\app.exe" />
                        </Field>
                      )}

                      <div className="grid gap-3 sm:grid-cols-2">
                        {needsYoutube && !settings.youtube_url.trim() && <WarningCard title="YouTube URL missing">The overlay will fall back to its cover instead of showing a video.</WarningCard>}
                        {needsLocal && !settings.local_video_path.trim() && <WarningCard title="Local video missing">Choose a file path before relying on local-video mode.</WarningCard>}
                        {needsApp && !settings.launch_app_path.trim() && <WarningCard title="Companion app missing">Launch-app mode has nothing configured to start yet.</WarningCard>}
                        {settings.panic_mode === 'fade' && <InfoCard title="Pure visual mode" icon="◐">The panic screen stays up only long enough for the configured transition unless you add an explicit timeout.</InfoCard>}
                      </div>
                    </div>

                    <div className="h-fit rounded-3xl border border-guiso-border bg-guiso-panel/85 p-5 shadow-xl shadow-black/10 xl:sticky xl:top-0">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-[9px] font-black uppercase tracking-[0.18em] text-stone-600">Behavior preview</p>
                          <p className="mt-1 text-sm font-black text-stone-100">{selectedMode?.label ?? 'Unknown'}</p>
                        </div>
                        <span className="rounded-full border border-emerald-500/15 bg-emerald-500/5 px-2 py-1 text-[8px] font-black uppercase tracking-wider text-emerald-300">armed</span>
                      </div>

                      <div className="mt-5 overflow-hidden rounded-2xl border border-guiso-border bg-black shadow-inner">
                        <div className="flex items-center gap-1.5 border-b border-white/5 bg-white/[0.018] px-3 py-2">
                          <span className="h-1.5 w-1.5 rounded-full bg-red-400/70" />
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-400/70" />
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/70" />
                          <span className="ml-auto text-[8px] font-mono text-white/15">Guiso overlay</span>
                        </div>
                        <div className="relative aspect-video">
                          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(245,158,11,.12),transparent_55%)]" />
                          <div className="absolute inset-x-5 top-1/2 -translate-y-1/2 rounded-2xl border border-white/10 bg-white/[0.025] p-4 backdrop-blur-sm">
                            <div className="flex items-center gap-3">
                              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/10 text-amber-300">{selectedMode?.icon ?? '•'}</span>
                              <div className="min-w-0">
                                <p className="truncate text-xs font-bold text-white/80">{needsYoutube ? 'Disguise video' : needsLocal ? settings.local_video_title || 'Local video' : needsApp ? 'Companion app' : 'System cover'}</p>
                                <p className="mt-1 text-[9px] text-white/30">Cleanup → action → safe recovery</p>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 space-y-2 text-[10px]">
                        <PreviewRow label="Process cleanup" value={targetSummary} />
                        <PreviewRow label="Base layer" value={needsYoutube ? 'YouTube' : needsLocal ? 'Local video' : 'Color cover'} />
                        <PreviewRow label="Visual layer" value={settings.panic_mode === 'combo' ? `${settings.combo_modes.length} combo layer${settings.combo_modes.length === 1 ? '' : 's'}` : 'Single mode'} />
                        <PreviewRow label="Close" value="Esc / rescue shortcut" />
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {tab === 'triggers' && (
                <section className="max-w-4xl space-y-5 animate-fade-in-up">
                  <div className="rounded-2xl border border-guiso-border bg-guiso-panel/85 p-5">
                    <SectionHeading title="Global shortcut" kicker="Primary trigger" description="Works even when Guiso is hidden in the tray." />
                    <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
                      <button
                        type="button"
                        onClick={() => setIsRecordingShortcut(true)}
                        className={`min-h-14 rounded-2xl border px-4 text-left font-mono text-sm transition ${isRecordingShortcut ? 'border-amber-500/30 bg-amber-500/8 text-amber-300' : 'border-guiso-border bg-guiso-panel-strong text-stone-200 hover:border-stone-700'}`}
                      >
                        <span className="block text-[9px] font-sans font-black uppercase tracking-[0.16em] text-stone-600">{isRecordingShortcut ? 'Listening' : 'Active shortcut'}</span>
                        <span className="mt-1 block">{isRecordingShortcut ? 'Press a key combination…' : settings.active_shortcut}</span>
                      </button>
                      <button type="button" onClick={() => setIsRecordingShortcut(true)} className={secondaryButton}>Record shortcut</button>
                    </div>
                    {settings.active_shortcut === RESCUE_SHORTCUT && (
                      <WarningCard title="Reserved recovery key">{RESCUE_SHORTCUT} is reserved by Guiso as an emergency close path. Choose another primary shortcut.</WarningCard>
                    )}
                    <div className="mt-3 flex items-center gap-3 rounded-2xl border border-amber-500/10 bg-amber-500/[0.035] px-3.5 py-3">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-xs text-amber-300">!</span>
                      <p className="text-[10px] leading-relaxed text-stone-600">Emergency recovery shortcut: <span className="font-mono text-amber-300/75">{RESCUE_SHORTCUT}</span>. It closes an active panic overlay without starting a new cleanup cycle.</p>
                    </div>
                    <label className="mt-3 flex cursor-pointer items-center gap-3 rounded-2xl border border-guiso-border bg-guiso-panel-strong px-3.5 py-3">
                      <input type="checkbox" checked={settings.panic_hotkey_close} onChange={(event) => update({ panic_hotkey_close: event.target.checked })} className="h-4 w-4 cursor-pointer accent-amber-500" />
                      <div>
                        <p className="text-xs font-bold text-stone-300">Second press closes the active disguise</p>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-stone-700">When enabled, the normal panic shortcut becomes a toggle while the overlay is active.</p>
                      </div>
                    </label>
                  </div>

                  <div className="rounded-2xl border border-guiso-border bg-guiso-panel/85 p-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <SectionHeading title="Mouse gesture" kicker="Optional trigger" description="Hold the selected button, draw your stroke, and release the same button." />
                      <label className="flex cursor-pointer items-center gap-2">
                        <input type="checkbox" checked={settings.gesture_enabled} onChange={(event) => update({ gesture_enabled: event.target.checked })} className="h-4 w-4 cursor-pointer accent-amber-500" />
                        <span className="text-xs font-bold text-stone-400">Enabled</span>
                      </label>
                    </div>

                    <div className="mt-5 grid gap-3 md:grid-cols-[200px_1fr]">
                      <div>
                        <p className="mb-2 text-[9px] font-black uppercase tracking-[0.15em] text-stone-600">Trigger button</p>
                        <div className="grid grid-cols-3 gap-1.5">
                          {(['middle', 'right', 'left'] as const).map((button) => (
                            <button key={button} type="button" onClick={() => update({ gesture_button: button })} className={`rounded-xl border px-2 py-2.5 text-[10px] font-black capitalize transition ${settings.gesture_button === button ? 'border-amber-500/20 bg-amber-500/7 text-amber-300' : 'border-guiso-border bg-guiso-panel-strong text-stone-600 hover:text-stone-300'}`}>
                              {button.slice(0, 1).toUpperCase()}
                            </button>
                          ))}
                        </div>
                        <p className="mt-2 text-[9px] leading-relaxed text-stone-700">{settings.gesture_button} mouse button</p>
                      </div>

                      <div>
                        <div className="flex items-center justify-between">
                          <p className="text-[9px] font-black uppercase tracking-[0.15em] text-stone-600">Recognition tolerance</p>
                          <span className="font-mono text-[10px] text-stone-300">{settings.gesture_threshold.toFixed(2)}</span>
                        </div>
                        <input type="range" min={0.05} max={0.5} step={0.01} value={settings.gesture_threshold} onChange={(event) => update({ gesture_threshold: Number.parseFloat(event.target.value) })} className="mt-4 w-full cursor-pointer accent-amber-500" />
                        <div className="mt-2 flex justify-between text-[9px] text-stone-700"><span>Strict</span><span>Forgiving</span></div>
                      </div>
                    </div>

                    <div className="mt-5">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[9px] font-black uppercase tracking-[0.15em] text-stone-600">Draw your gesture</p>
                          <p className="mt-1 text-[9px] text-stone-700">Saved automatically after a valid stroke.</p>
                        </div>
                        {gesturePoints.length > 0 && <button type="button" onClick={clearGesturePreview} className="text-[9px] font-black text-stone-600 transition hover:text-stone-300">Clear preview</button>}
                      </div>
                      <div className="overflow-hidden rounded-2xl border border-dashed border-stone-800 bg-black/10">
                        <canvas
                          ref={canvasRef}
                          width={760}
                          height={250}
                          onPointerDown={startDrawing}
                          onPointerMove={continueDrawing}
                          onPointerUp={(event) => void finishDrawing(event)}
                          onPointerCancel={(event) => void finishDrawing(event)}
                          className="block h-auto w-full cursor-crosshair touch-none"
                        />
                        <div className="flex items-center justify-between border-t border-stone-800/70 px-3 py-2 text-[9px] text-stone-700">
                          <span>{settings.panic_gesture.length > 0 ? 'A saved gesture is configured.' : 'No saved gesture yet.'}</span>
                          {gestureScore !== null && <span className="font-mono text-stone-400">Score {gestureScore.toFixed(4)}</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {tab === 'appearance' && (
                <section className="max-w-4xl space-y-5 animate-fade-in-up">
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
                    <div className="space-y-4">
                      <div className="rounded-2xl border border-guiso-border bg-guiso-panel/85 p-5">
                        <SectionHeading title="Overlay backdrop" kicker="Visual cover" description="Set the color and opacity of the safety layer shown behind or over visual disguises." />
                        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center">
                          <div className="relative h-14 w-16 shrink-0 overflow-hidden rounded-2xl border border-guiso-border">
                            <input type="color" value={color.hex} onChange={(event) => update({ panic_color: hexToRgba(event.target.value, color.alpha) })} className="absolute -inset-2 h-20 w-24 cursor-pointer" aria-label="Overlay color" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between text-[10px] text-stone-600">
                              <span>Opacity</span>
                              <span className="font-mono text-stone-300">{Math.round(color.alpha * 100)}%</span>
                            </div>
                            <input type="range" min={0} max={1} step={0.01} value={color.alpha} onChange={(event) => update({ panic_color: hexToRgba(color.hex, Number.parseFloat(event.target.value)) })} className="mt-3 w-full cursor-pointer accent-amber-500" />
                          </div>
                        </div>
                        {color.alpha < 0.99 && <div className="mt-4 rounded-xl border border-amber-500/10 bg-amber-500/[0.03] px-3.5 py-3 text-[9px] leading-relaxed text-stone-700">A translucent cover allows some of the layer beneath it to remain visible. Use higher opacity for a stronger cover.</div>}
                        <div className="mt-4 overflow-hidden rounded-2xl border border-guiso-border" style={{ backgroundColor: settings.panic_color }}>
                          <div className="flex h-28 items-end justify-between p-4">
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-white/40">Panic cover</p>
                              <p className="mt-1 text-sm font-bold text-white/75">Preview surface</p>
                            </div>
                            <span className="rounded-lg border border-white/10 bg-black/15 px-2 py-1 text-[9px] font-mono text-white/35">{color.hex}</span>
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <SliderField label="Blur strength" value={settings.panic_blur_px} min={0} max={80} suffix="px" hint="Used by the glitch desktop snapshot layer." onChange={(value) => update({ panic_blur_px: value })} />
                        <SliderField label="Fade-in duration" value={settings.panic_fade_ms} min={0} max={5000} step={50} suffix="ms" hint="Controls the entrance animation." onChange={(value) => update({ panic_fade_ms: value })} />
                      </div>

                      <SliderField label="Auto-close overlay" value={settings.panic_auto_close_ms} min={0} max={60_000} step={500} suffix="ms" hint="0 keeps media disguises open. Transient modes retain a backend safety close." onChange={(value) => update({ panic_auto_close_ms: value })} />

                      <div className="rounded-2xl border border-guiso-border bg-guiso-panel/85 p-5">
                        <SectionHeading title="Interface theme" kicker="Settings window" description="Choose a quieter panel treatment without changing the panic screen itself." />
                        <div className="mt-4 grid gap-2 sm:grid-cols-2">
                          {(['dark', 'dim'] as const).map((theme) => {
                            const active = settings.theme === theme;
                            return (
                              <button key={theme} type="button" onClick={() => update({ theme })} className={`rounded-xl border p-3 text-left transition ${active ? 'border-amber-500/20 bg-amber-500/[0.055]' : 'border-guiso-border bg-guiso-panel-strong hover:border-stone-700'}`}>
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-bold capitalize text-stone-200">{theme}</span>
                                  {active && <span className="text-[8px] font-black uppercase tracking-wider text-amber-400">Active</span>}
                                </div>
                                <p className="mt-1 text-[9px] leading-relaxed text-stone-700">{theme === 'dark' ? 'Deep contrast with brighter controls.' : 'Softer surfaces and lower contrast.'}</p>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    <div className="h-fit rounded-3xl border border-guiso-border bg-guiso-panel/85 p-5 xl:sticky xl:top-0">
                      <p className="text-[9px] font-black uppercase tracking-[0.18em] text-stone-600">Recovery model</p>
                      <div className="mt-4 space-y-3">
                        <RecoveryStep number="1" title="Cleanup" detail="Process targets are handled first." />
                        <RecoveryStep number="2" title="Cover" detail="A native dark window is created before the web content is shown." active />
                        <RecoveryStep number="3" title="Exit" detail="Escape, the configured hotkey, or the rescue shortcut closes safely." />
                      </div>
                      <div className="mt-5 rounded-2xl border border-emerald-500/10 bg-emerald-500/[0.03] p-3.5">
                        <p className="text-[9px] font-black uppercase tracking-[0.16em] text-emerald-300/75">Hard safety net</p>
                        <p className="mt-1.5 text-[10px] leading-relaxed text-stone-700">Transient overlays are closed from the backend even if the frontend animation or media fails.</p>
                      </div>
                    </div>
                  </div>
                </section>
              )}
            </div>
          </main>

          <footer className="shrink-0 border-t border-guiso-border bg-guiso-footer/95 px-7 py-3.5 backdrop-blur-xl">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${dirty ? 'bg-amber-500/10 text-amber-300' : 'bg-emerald-500/10 text-emerald-300'}`}>{dirty ? '!' : '✓'}</span>
                <p className="truncate text-[10px] text-stone-600">{dirty ? 'Changes are local until you save them.' : 'All settings are saved. The global trigger is armed; Escape and the rescue shortcut remain available during panic.'}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {dirty && <button type="button" onClick={discardChanges} disabled={isSaving} className={secondaryButton}>Discard</button>}
                <button type="button" onClick={() => void saveSettings()} disabled={isSaving || !dirty} className={primaryButton}>{isSaving ? 'Saving…' : dirty ? 'Save Settings' : 'Saved'}</button>
              </div>
            </div>
          </footer>
        </section>
      </div>

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-[200] -translate-x-1/2 rounded-2xl border border-guiso-border bg-[#181411]/95 px-4 py-3 text-xs font-bold text-stone-200 shadow-2xl shadow-black/30 backdrop-blur-xl animate-fade-in-up" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function LoadingScreen({ firstLoad }: { firstLoad: boolean }) {
  return (
    <div className="flex h-screen items-center justify-center bg-guiso-bg text-stone-400">
      <div className="w-full max-w-sm px-6 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl border border-guiso-border bg-guiso-panel text-amber-300 shadow-xl shadow-black/10">
          <span className="text-2xl">⚡</span>
        </div>
        <p className="mt-4 text-sm font-black text-stone-200">Loading Guiso</p>
        <p className="mt-1 text-[10px] leading-relaxed text-stone-700">{firstLoad ? 'Reading saved configuration and scanning running processes…' : 'Recovering the settings window…'}</p>
      </div>
    </div>
  );
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[10px]">
      <span className="text-stone-700">{label}</span>
      <span className={`truncate text-stone-400 ${mono ? 'max-w-28 font-mono text-amber-500/70' : ''}`}>{value}</span>
    </div>
  );
}

function RecipeStep({ number, title, detail }: { number: string; title: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-guiso-border bg-guiso-panel-strong p-3.5">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.025] text-[10px] font-black text-stone-500">{number}</span>
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-stone-400">{title}</p>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-stone-700">{detail}</p>
    </div>
  );
}

function QuickLink({ icon, title, detail, onClick }: { icon: string; title: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group rounded-2xl border border-guiso-border bg-guiso-panel/70 p-4 text-left transition hover:border-stone-700 hover:bg-guiso-panel">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/[0.025] text-sm text-stone-500 transition group-hover:text-amber-300">{icon}</span>
        <div className="min-w-0">
          <p className="text-xs font-black text-stone-200">{title}</p>
          <p className="mt-1 text-[10px] leading-relaxed text-stone-700">{detail}</p>
        </div>
        <span className="ml-auto text-stone-800 transition group-hover:translate-x-0.5 group-hover:text-stone-500">→</span>
      </div>
    </button>
  );
}

function SummaryCard({ title, value, detail, icon, tone, compact = false }: { title: string; value: string | number; detail: string; icon: string; tone: 'red' | 'amber' | 'stone'; compact?: boolean }) {
  const toneClass = tone === 'red' ? 'bg-red-500/6 text-red-300' : tone === 'amber' ? 'bg-amber-500/6 text-amber-300' : 'bg-white/[0.025] text-stone-400';
  return (
    <div className="rounded-2xl border border-guiso-border bg-guiso-panel/85 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[9px] font-black uppercase tracking-[0.16em] text-stone-700">{title}</p>
        <span className={`flex h-7 w-7 items-center justify-center rounded-lg text-xs ${toneClass}`}>{icon}</span>
      </div>
      <p className={`mt-3 truncate font-black text-stone-100 ${compact ? 'text-sm' : 'text-2xl'}`}>{value}</p>
      <p className="mt-1 text-[10px] leading-relaxed text-stone-700">{detail}</p>
    </div>
  );
}

function InfoCard({ title, icon, children }: { title: string; icon: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-guiso-border bg-guiso-panel/65 p-4">
      <div className="flex gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/[0.025] text-xs text-stone-500">{icon}</span>
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-stone-500">{title}</p>
          <p className="mt-1.5 text-[10px] leading-relaxed text-stone-700">{children}</p>
        </div>
      </div>
    </div>
  );
}

function WarningCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-amber-500/12 bg-amber-500/[0.03] p-4">
      <div className="flex gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/8 text-xs text-amber-300">!</span>
        <div>
          <p className="text-[10px] font-black text-amber-200/85">{title}</p>
          <p className="mt-1 text-[9px] leading-relaxed text-stone-700">{children}</p>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-guiso-border bg-guiso-panel/85 p-4">
      <label className="block text-[10px] font-black uppercase tracking-[0.14em] text-stone-500">{label}</label>
      <div className="mt-2">{children}</div>
      {hint && <p className="mt-2 text-[9px] leading-relaxed text-stone-700">{hint}</p>}
    </div>
  );
}

function SectionHeading({ title, kicker, description }: { title: string; kicker: string; description: string }) {
  return (
    <div>
      <p className="text-[9px] font-black uppercase tracking-[0.17em] text-amber-500/55">{kicker}</p>
      <p className="mt-1 text-sm font-black text-stone-100">{title}</p>
      <p className="mt-1 text-[10px] leading-relaxed text-stone-700">{description}</p>
    </div>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-guiso-border/60 pb-2 last:border-b-0 last:pb-0">
      <span className="text-stone-700">{label}</span>
      <span className="max-w-40 truncate font-medium text-stone-400">{value}</span>
    </div>
  );
}

function RecoveryStep({ number, title, detail, active = false }: { number: string; title: string; detail: string; active?: boolean }) {
  return (
    <div className="flex gap-3">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-black ${active ? 'bg-amber-500/10 text-amber-300' : 'bg-white/[0.025] text-stone-600'}`}>{number}</span>
      <div>
        <p className="text-[10px] font-black text-stone-300">{title}</p>
        <p className="mt-0.5 text-[9px] leading-relaxed text-stone-700">{detail}</p>
      </div>
    </div>
  );
}

function SliderField({ label, value, min, max, step = 1, suffix, hint, onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix: string; hint: string; onChange: (value: number) => void }) {
  return (
    <div className="rounded-2xl border border-guiso-border bg-guiso-panel/85 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-stone-500">{label}</p>
          <p className="mt-1 text-[9px] text-stone-700">{hint}</p>
        </div>
        <span className="rounded-lg border border-guiso-border bg-black/10 px-2 py-1 font-mono text-[10px] text-stone-300">{value}{suffix}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="mt-4 w-full cursor-pointer accent-amber-500" />
      <div className="mt-2 flex justify-between text-[8px] font-semibold text-stone-800"><span>{min}{suffix}</span><span>{max}{suffix}</span></div>
    </div>
  );
}

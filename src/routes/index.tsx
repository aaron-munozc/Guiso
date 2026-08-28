import { useEffect, useState, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { createFileRoute } from '@tanstack/react-router';
import { hexToRgba, parseRgba } from '../lib/color';
import {
  COMBO_OPTIONS,
  PANIC_MODES,
  type ComboMode,
  type ProcessInfo,
  type UserSettings,
} from '../lib/types';

export const Route = createFileRoute('/')({
  component: RouteComponent,
});

type Tab = 'targets' | 'action' | 'triggers' | 'appearance';

function RouteComponent() {
  const [tab, setTab] = useState<Tab>('targets');
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [search, setSearch] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [sessionPids, setSessionPids] = useState<number[]>([]);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isTestingPanic, setIsTestingPanic] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const pointsRef = useRef<{ x: number; y: number }[]>([]);
  const [gestureScore, setGestureScore] = useState<number | null>(null);

  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  }, []);

  const fetchProcesses = async () => {
    setIsRefreshing(true);
    try {
      const list = await invoke<ProcessInfo[]>('get_processes');
      setProcesses(list);
    } catch (e) {
      console.error(e);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    invoke<UserSettings>('get_settings').then(setSettings);
    invoke<number[]>('get_queued_pids').then(setSessionPids);
    fetchProcesses();
  }, []);

  useEffect(() => {
    if (!isRecordingShortcut) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const keys: string[] = [];
      if (e.ctrlKey || e.metaKey) keys.push('CmdOrCtrl');
      if (e.altKey) keys.push('Alt');
      if (e.shiftKey) keys.push('Shift');
      let keyName = e.key.toUpperCase();
      if (keyName === ' ') keyName = 'SPACE';
      keys.push(keyName);
      setSettings((s) => (s ? { ...s, active_shortcut: keys.join('+') } : null));
      setIsRecordingShortcut(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isRecordingShortcut]);

  const handleMinimizeToTray = () => getCurrentWebviewWindow().hide();

  const toggleSessionPid = async (pid: number) => {
    if (sessionPids.includes(pid)) {
      await invoke('remove_pid', { pid });
      setSessionPids((p) => p.filter((id) => id !== pid));
    } else {
      await invoke('add_pid', { pid });
      setSessionPids((p) => [...p, pid]);
    }
  };

  const toggleSavedName = (name: string) => {
    if (!settings) return;
    const lower = name.toLowerCase();
    const exists = settings.saved_kill_processes.some(
      (n) => n.toLowerCase() === lower,
    );
    setSettings({
      ...settings,
      saved_kill_processes: exists
        ? settings.saved_kill_processes.filter(
            (n) => n.toLowerCase() !== lower,
          )
        : [...settings.saved_kill_processes, name],
    });
  };

  const isNameSaved = (name: string) =>
    settings?.saved_kill_processes.some(
      (n) => n.toLowerCase() === name.toLowerCase(),
    ) ?? false;

  const saveSettings = async () => {
    if (!settings) return;
    setIsSaving(true);
    try {
      await invoke('update_settings', { newSettings: settings });
      showToast('Settings saved');
    } catch (e) {
      showToast('Failed to save settings');
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  const saveKillList = async () => {
    if (!settings) return;
    try {
      await invoke('save_kill_list', { names: settings.saved_kill_processes });
      showToast('Kill list persisted');
    } catch (e) {
      showToast('Failed to save kill list');
      console.error(e);
    }
  };

  const testPanic = async () => {
    setIsTestingPanic(true);
    try {
      await invoke('trigger_panic');
    } finally {
      setTimeout(() => setIsTestingPanic(false), 1200);
    }
  };

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsDrawing(true);
    setGestureScore(null);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    pointsRef.current = [{ x: e.clientX - rect.left, y: e.clientY - rect.top }];
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.beginPath();
      ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
    }
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    pointsRef.current.push({ x, y });
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) {
      ctx.lineTo(x, y);
      ctx.strokeStyle = '#d97706';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  };

  const finishDrawing = async () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    if (pointsRef.current.length <= 5) return;
    await invoke('save_gesture', { rawPoints: pointsRef.current });
    const score = await invoke<number>('test_gesture_score', {
      rawPoints: pointsRef.current,
    });
    setGestureScore(score);
    showToast('Gesture saved');
  };

  const toggleComboMode = (mode: ComboMode) => {
    if (!settings) return;
    const has = settings.combo_modes.includes(mode);
    setSettings({
      ...settings,
      combo_modes: has
        ? settings.combo_modes.filter((m) => m !== mode)
        : [...settings.combo_modes, mode],
    });
  };

  const filtered = processes.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()),
  );

  const savedCount = settings?.saved_kill_processes.length ?? 0;
  const sessionCount = sessionPids.length;
  const color = settings ? parseRgba(settings.panic_color) : null;

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'targets', label: 'Kill Targets', icon: '◎' },
    { id: 'action', label: 'Panic Action', icon: '⚡' },
    { id: 'triggers', label: 'Triggers', icon: '⌨' },
    { id: 'appearance', label: 'Appearance', icon: '◐' },
  ];

  if (!settings) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#0a0908] text-stone-400 text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-[#0a0908] text-stone-200 overflow-hidden select-none">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 flex flex-col border-r border-[#2a2622] bg-[#0f0e0c]">
        <div
          data-tauri-drag-region
          className="px-5 pt-6 pb-5 border-b border-[#2a2622]/60"
        >
          <div className="flex items-center gap-3">
            <img
              src="/logo_dark.svg"
              alt="Guiso"
              className="w-9 h-9 rounded-lg"
              draggable={false}
            />
            <div>
              <h1 className="text-base font-bold tracking-tight text-stone-50">
                Guiso
              </h1>
              <p className="text-[10px] text-stone-500 font-medium uppercase tracking-widest">
                Panic Button
              </p>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${
                tab === t.id
                  ? 'bg-amber-600/15 text-amber-400 border border-amber-600/25'
                  : 'text-stone-400 hover:text-stone-200 hover:bg-[#1c1917] border border-transparent'
              }`}
            >
              <span className="text-base opacity-70">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>

        <div className="p-4 border-t border-[#2a2622]/60 space-y-2">
          <div className="px-3 py-2 rounded-lg bg-[#141210] border border-[#2a2622] text-[11px] space-y-1">
            <div className="flex justify-between text-stone-500">
              <span>Shortcut</span>
              <span className="font-mono text-amber-500/80 text-[10px]">
                {settings.active_shortcut}
              </span>
            </div>
            <div className="flex justify-between text-stone-500">
              <span>Targets</span>
              <span className="text-stone-300">
                {savedCount} saved · {sessionCount} session
              </span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header
          data-tauri-drag-region
          className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-[#2a2622]/60 bg-[#0a0908]/80"
        >
          <div>
            <h2 className="text-lg font-semibold text-stone-50">
              {tabs.find((t) => t.id === tab)?.label}
            </h2>
            <p className="text-xs text-stone-500 mt-0.5">
              {tab === 'targets' &&
                'Select processes to close when panic is triggered'}
              {tab === 'action' &&
                'Choose what happens after processes are killed'}
              {tab === 'triggers' &&
                'Configure keyboard shortcut and mouse gesture'}
              {tab === 'appearance' &&
                'Customize overlay visuals and timing'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={testPanic}
              disabled={isTestingPanic}
              className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-amber-600/20 border border-amber-600/40 text-amber-400 hover:bg-amber-600/30 transition-all cursor-pointer disabled:opacity-50 animate-pulse-ring"
            >
              {isTestingPanic ? 'Triggered…' : 'Test Panic'}
            </button>
            <button
              onClick={handleMinimizeToTray}
              className="px-3.5 py-2 text-xs font-medium rounded-lg bg-[#1c1917] border border-[#2a2622] text-stone-400 hover:text-stone-200 hover:border-stone-600 transition-all cursor-pointer"
            >
              Hide to Tray
            </button>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto custom-scrollbar p-6 animate-fade-in-up">
          {/* ── Kill Targets ── */}
          {tab === 'targets' && (
            <div className="space-y-4 max-w-4xl">
              <div className="flex gap-3">
                <input
                  type="text"
                  placeholder="Search running processes…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="flex-1 px-4 py-2.5 bg-[#141210] border border-[#2a2622] rounded-lg text-sm text-stone-200 placeholder-stone-600 focus:outline-none focus:border-amber-600/50 focus:ring-1 focus:ring-amber-600/30 select-text"
                />
                <button
                  onClick={fetchProcesses}
                  disabled={isRefreshing}
                  className="px-4 py-2.5 text-sm font-medium rounded-lg bg-[#1c1917] border border-[#2a2622] hover:border-stone-600 transition-all cursor-pointer disabled:opacity-50"
                >
                  {isRefreshing ? 'Scanning…' : 'Refresh'}
                </button>
              </div>

              {settings.saved_kill_processes.length > 0 && (
                <div className="p-4 rounded-xl bg-[#141210] border border-[#2a2622]">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold text-stone-400 uppercase tracking-wider">
                      Saved targets (persistent)
                    </span>
                    <button
                      onClick={saveKillList}
                      className="text-[11px] font-medium text-amber-500 hover:text-amber-400 cursor-pointer"
                    >
                      Persist to disk
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {settings.saved_kill_processes.map((name) => (
                      <span
                        key={name}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-500/10 border border-red-500/25 text-red-300 text-xs font-medium"
                      >
                        {name}
                        <button
                          onClick={() => toggleSavedName(name)}
                          className="opacity-60 hover:opacity-100 cursor-pointer"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-[#2a2622] overflow-hidden bg-[#141210]">
                <div className="max-h-[calc(100vh-280px)] overflow-y-auto custom-scrollbar">
                  {filtered.length === 0 ? (
                    <p className="p-8 text-center text-stone-500 text-sm">
                      No matching processes
                    </p>
                  ) : (
                    filtered.map((proc) => {
                      const inSession = sessionPids.includes(proc.pid);
                      const saved = isNameSaved(proc.name);
                      return (
                        <div
                          key={proc.pid}
                          className="flex items-center gap-3 px-4 py-2.5 border-b border-[#2a2622]/50 hover:bg-[#1c1917]/60 transition-colors group"
                        >
                          {proc.icon ? (
                            <img
                              src={proc.icon}
                              alt=""
                              className="w-7 h-7 object-contain"
                            />
                          ) : (
                            <div className="w-7 h-7 rounded bg-[#2a2622] flex items-center justify-center text-[10px] text-stone-500">
                              ?
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-stone-200 truncate">
                              {proc.name}
                            </p>
                            <p className="text-[11px] text-stone-500 font-mono">
                              PID {proc.pid} · {proc.memory_mb} MB ·{' '}
                              {proc.cpu_usage.toFixed(1)}% CPU
                            </p>
                          </div>
                          <div className="flex gap-1.5 shrink-0">
                            <button
                              onClick={() => toggleSavedName(proc.name)}
                              className={`px-2.5 py-1 text-[11px] font-semibold rounded-md border transition-all cursor-pointer ${
                                saved
                                  ? 'bg-red-500/15 border-red-500/30 text-red-400'
                                  : 'bg-transparent border-[#2a2622] text-stone-500 hover:text-stone-300 hover:border-stone-600 opacity-0 group-hover:opacity-100'
                              }`}
                            >
                              {saved ? 'Saved' : 'Save'}
                            </button>
                            <button
                              onClick={() => toggleSessionPid(proc.pid)}
                              className={`px-2.5 py-1 text-[11px] font-semibold rounded-md border transition-all cursor-pointer ${
                                inSession
                                  ? 'bg-amber-600/15 border-amber-600/30 text-amber-400'
                                  : 'bg-[#1c1917] border-[#2a2622] text-stone-400 hover:border-stone-600'
                              }`}
                            >
                              {inSession ? 'Queued' : 'Queue'}
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
              <p className="text-[11px] text-stone-600 leading-relaxed">
                <strong className="text-stone-500">Saved</strong> targets persist
                across restarts (matched by process name).{' '}
                <strong className="text-stone-500">Queued</strong> targets are
                session-only and matched by PID.
              </p>
            </div>
          )}

          {/* ── Panic Action ── */}
          {tab === 'action' && (
            <div className="space-y-5 max-w-2xl">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {PANIC_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() =>
                      setSettings({ ...settings, panic_mode: mode.id })
                    }
                    className={`p-4 rounded-xl border text-left transition-all cursor-pointer ${
                      settings.panic_mode === mode.id
                        ? 'bg-amber-600/10 border-amber-600/40 ring-1 ring-amber-600/20'
                        : 'bg-[#141210] border-[#2a2622] hover:border-stone-600'
                    }`}
                  >
                    <p
                      className={`text-sm font-semibold ${
                        settings.panic_mode === mode.id
                          ? 'text-amber-400'
                          : 'text-stone-200'
                      }`}
                    >
                      {mode.label}
                    </p>
                    <p className="text-[11px] text-stone-500 mt-1 leading-snug">
                      {mode.desc}
                    </p>
                  </button>
                ))}
              </div>

              {settings.panic_mode === 'combo' && (
                <div className="p-4 rounded-xl bg-[#141210] border border-[#2a2622] space-y-3">
                  <p className="text-xs font-semibold text-stone-400 uppercase tracking-wider">
                    Combo actions
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {COMBO_OPTIONS.map((opt) => (
                      <label
                        key={opt.id}
                        className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-[#1c1917] border border-[#2a2622] cursor-pointer hover:border-stone-600 transition-all"
                      >
                        <input
                          type="checkbox"
                          checked={settings.combo_modes.includes(opt.id)}
                          onChange={() => toggleComboMode(opt.id)}
                          className="w-3.5 h-3.5 accent-amber-600 cursor-pointer"
                        />
                        <span className="text-sm text-stone-300">
                          {opt.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {(settings.panic_mode === 'youtube' ||
                settings.panic_mode === 'launch_app' ||
                (settings.panic_mode === 'combo' &&
                  settings.combo_modes.some(
                    (m) => m === 'youtube' || m === 'launch_app',
                  ))) && (
                <Field
                  label={
                    settings.panic_mode === 'launch_app' ||
                    settings.combo_modes.includes('launch_app')
                      ? 'Application path'
                      : 'YouTube URL'
                  }
                  hint={
                    settings.panic_mode === 'launch_app' ||
                    settings.combo_modes.includes('launch_app')
                      ? 'Executable or script to spawn silently'
                      : 'Watch or embed URL — auto-converted to embed'
                  }
                >
                  <input
                    type="text"
                    value={settings.panic_target}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        panic_target: e.target.value,
                      })
                    }
                    placeholder={
                      settings.panic_mode === 'youtube' ||
                      settings.combo_modes.includes('youtube')
                        ? 'https://youtube.com/watch?v=…'
                        : 'C:\\path\\to\\app.exe'
                    }
                    className={inputClass}
                  />
                </Field>
              )}

              {settings.panic_mode === 'local' && (
                <>
                  <Field label="Video file path" hint="Absolute path on disk">
                    <input
                      type="text"
                      value={settings.local_video_path}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          local_video_path: e.target.value,
                        })
                      }
                      className={inputClass}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Window title">
                      <input
                        type="text"
                        value={settings.local_video_title}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            local_video_title: e.target.value,
                          })
                        }
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Start time (seconds)">
                      <input
                        type="number"
                        min={0}
                        value={settings.local_video_start_time}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            local_video_start_time:
                              parseInt(e.target.value) || 0,
                          })
                        }
                        className={inputClass}
                      />
                    </Field>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Triggers ── */}
          {tab === 'triggers' && (
            <div className="space-y-5 max-w-2xl">
              <div className="p-5 rounded-xl bg-[#141210] border border-[#2a2622] space-y-4">
                <p className="text-xs font-semibold text-stone-400 uppercase tracking-wider">
                  Global shortcut
                </p>
                <button
                  type="button"
                  onClick={() => setIsRecordingShortcut(true)}
                  className={`w-full text-left px-4 py-3 border rounded-lg text-sm font-mono transition-all cursor-pointer ${
                    isRecordingShortcut
                      ? 'bg-amber-600/10 border-amber-600/40 text-amber-400 animate-pulse'
                      : 'bg-[#0a0908] border-[#2a2622] text-stone-200 hover:border-stone-600'
                  }`}
                >
                  {isRecordingShortcut
                    ? 'Press key combination…'
                    : settings.active_shortcut}
                </button>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.panic_hotkey_close}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        panic_hotkey_close: e.target.checked,
                      })
                    }
                    className="w-4 h-4 accent-amber-600 cursor-pointer"
                  />
                  <span className="text-sm text-stone-300">
                    Press shortcut again to dismiss overlay
                  </span>
                </label>
              </div>

              <div className="p-5 rounded-xl bg-[#141210] border border-[#2a2622] space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-stone-400 uppercase tracking-wider">
                    Mouse gesture
                  </p>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.gesture_enabled}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          gesture_enabled: e.target.checked,
                        })
                      }
                      className="w-4 h-4 accent-amber-600 cursor-pointer"
                    />
                    <span className="text-xs font-medium text-stone-400">
                      Enabled
                    </span>
                  </label>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  {(['middle', 'right', 'left'] as const).map((btn) => (
                    <button
                      key={btn}
                      type="button"
                      onClick={() =>
                        setSettings({ ...settings, gesture_button: btn })
                      }
                      className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all cursor-pointer capitalize ${
                        settings.gesture_button === btn
                          ? 'bg-amber-600/15 border-amber-600/35 text-amber-400'
                          : 'bg-[#1c1917] border-[#2a2622] text-stone-500 hover:border-stone-600'
                      }`}
                    >
                      {btn} click
                    </button>
                  ))}
                </div>

                <div>
                  <div className="flex justify-between text-xs text-stone-500 mb-1.5">
                    <span>Match strictness</span>
                    <span className="font-mono text-stone-400">
                      {settings.gesture_threshold.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.05}
                    max={0.5}
                    step={0.01}
                    value={settings.gesture_threshold}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        gesture_threshold: parseFloat(e.target.value),
                      })
                    }
                    className="w-full accent-amber-600 cursor-pointer"
                  />
                  <p className="text-[10px] text-stone-600 mt-1">
                    Lower = stricter match. Recommended 0.15–0.25
                  </p>
                </div>

                <div>
                  <p className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider mb-2">
                    Draw your gesture
                  </p>
                  <canvas
                    ref={canvasRef}
                    width={420}
                    height={180}
                    onMouseDown={startDrawing}
                    onMouseMove={draw}
                    onMouseUp={finishDrawing}
                    onMouseLeave={finishDrawing}
                    className="w-full max-w-[420px] bg-[#0a0908] border border-dashed border-[#2a2622] rounded-lg cursor-crosshair hover:border-stone-600 transition-colors"
                  />
                  {gestureScore !== null && (
                    <p className="text-[11px] text-stone-500 mt-2 font-mono">
                      Test score: {gestureScore.toFixed(4)} (lower = better)
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Appearance ── */}
          {tab === 'appearance' && color && (
            <div className="space-y-5 max-w-2xl">
              <div className="p-5 rounded-xl bg-[#141210] border border-[#2a2622] space-y-4">
                <p className="text-xs font-semibold text-stone-400 uppercase tracking-wider">
                  Overlay backdrop
                </p>
                <div className="flex items-center gap-4">
                  <div className="relative w-12 h-10 rounded-lg overflow-hidden border border-[#2a2622] shrink-0">
                    <input
                      type="color"
                      value={color.hex}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          panic_color: hexToRgba(e.target.value, color.alpha),
                        })
                      }
                      className="absolute -inset-2 w-[150%] h-[150%] cursor-pointer"
                    />
                  </div>
                  <div className="flex-1">
                    <div className="flex justify-between text-xs text-stone-500 mb-1">
                      <span>Opacity</span>
                      <span>{Math.round(color.alpha * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={color.alpha}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          panic_color: hexToRgba(
                            color.hex,
                            parseFloat(e.target.value),
                          ),
                        })
                      }
                      className="w-full accent-amber-600 cursor-pointer"
                    />
                  </div>
                </div>
                <div
                  className="h-16 rounded-lg border border-[#2a2622]"
                  style={{
                    backgroundColor: settings.panic_color,
                    backdropFilter: `blur(${settings.panic_blur_px}px)`,
                  }}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field label="Blur strength (px)">
                  <input
                    type="number"
                    min={0}
                    max={80}
                    value={settings.panic_blur_px}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        panic_blur_px: parseInt(e.target.value) || 0,
                      })
                    }
                    className={inputClass}
                  />
                </Field>
                <Field label="Fade-in duration (ms)">
                  <input
                    type="number"
                    min={0}
                    max={5000}
                    value={settings.panic_fade_ms}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        panic_fade_ms: parseInt(e.target.value) || 0,
                      })
                    }
                    className={inputClass}
                  />
                </Field>
              </div>

              <Field
                label="Auto-close overlay (ms)"
                hint="0 = stay open until dismissed manually"
              >
                <input
                  type="number"
                  min={0}
                  value={settings.panic_auto_close_ms}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      panic_auto_close_ms: parseInt(e.target.value) || 0,
                    })
                  }
                  className={inputClass}
                />
              </Field>
            </div>
          )}
        </main>

        {/* Footer save bar */}
        <footer className="shrink-0 flex items-center justify-between px-6 py-3 border-t border-[#2a2622]/60 bg-[#0f0e0c]">
          <p className="text-[11px] text-stone-600">
            Panic kills targets first, then runs your configured action
          </p>
          <button
            onClick={saveSettings}
            disabled={isSaving}
            className="px-5 py-2 text-sm font-semibold rounded-lg bg-amber-600 hover:bg-amber-500 text-stone-950 transition-all cursor-pointer disabled:opacity-50 shadow-[0_0_20px_rgba(217,119,6,0.15)]"
          >
            {isSaving ? 'Saving…' : 'Save Settings'}
          </button>
        </footer>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-lg bg-[#1c1917] border border-[#2a2622] text-sm text-stone-200 shadow-xl animate-fade-in-up z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

const inputClass =
  'w-full px-4 py-2.5 bg-[#0a0908] border border-[#2a2622] rounded-lg text-sm text-stone-200 placeholder-stone-600 focus:outline-none focus:border-amber-600/50 focus:ring-1 focus:ring-amber-600/30 select-text';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold text-stone-400">
        {label}
      </label>
      {children}
      {hint && <p className="text-[10px] text-stone-600">{hint}</p>}
    </div>
  );
}

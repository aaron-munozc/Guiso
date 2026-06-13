import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import {createFileRoute} from "@tanstack/react-router";

export const Route = createFileRoute('/')({
    component: RouteComponent,
});

interface ProcessInfo {
    pid: number;
    name: string;
    cpu_usage: number;
    memory_mb: number;
    icon: string | null;
}

interface UserSettings {
    active_shortcut: string;
    theme: string;
    panic_mode: 'youtube' | 'local' | 'color' | 'launch_app' | 'glitch';
    panic_target: string;
    panic_fade_ms: number;
    panic_color: string;
    panic_blur_px: number;
}

function RouteComponent() {
    const [activeTab, setActiveTab] = useState<'matrix' | 'settings'>('matrix');
    const [processes, setProcesses] = useState<ProcessInfo[]>([]);
    const [search, setSearch] = useState('');

    // Tracked PIDs state to instantly toggle UI buttons
    const [trackedPids, setTrackedPids] = useState<number[]>([]);

    // Settings state
    const [settings, setSettings] = useState<UserSettings | null>(null);

    useEffect(() => {
        // Load initial settings
        invoke<UserSettings>('get_settings').then(setSettings);

        // Poll process tree
        const interval = setInterval(async () => {
            const list = await invoke<ProcessInfo[]>('get_processes');
            setProcesses(list);
        }, 3000);

        return () => clearInterval(interval);
    }, []);

    const handleMinimizeToTray = async () => {
        await getCurrentWebviewWindow().hide();
    };

    const toggleTrack = async (pid: number) => {
        if (trackedPids.includes(pid)) {
            await invoke('remove_pid', { pid });
            setTrackedPids((prev) => prev.filter((id) => id !== pid));
        } else {
            await invoke('add_pid', { pid });
            setTrackedPids((prev) => [...prev, pid]);
        }
    };

    const saveSettings = async (e: React.FormEvent) => {
        e.preventDefault();
        if (settings) {
            await invoke('update_settings', { newSettings: settings });
            alert('Configuration synchronized.');
        }
    };

    const filtered = processes.filter((p) =>
        p.name.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="w-full h-screen bg-neutral-950 text-neutral-100 flex flex-col p-6 antialiased selection:bg-emerald-500/30">
            {/* Header */}
            <div className="flex items-center justify-between pb-6 border-b border-neutral-800">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-white">Application Matrix</h1>
                    <p className="text-sm text-neutral-400 mt-0.5">Stealth operations and process management</p>
                </div>
                <button
                    onClick={handleMinimizeToTray}
                    className="px-4 py-2 bg-neutral-900 border border-neutral-800 hover:bg-neutral-800 text-neutral-300 text-xs font-medium rounded-lg transition-all shadow-sm"
                >
                    Hide to Tray
                </button>
            </div>

            {/* Tab Navigation */}
            <div className="flex space-x-1 mt-6 mb-4 p-1 bg-neutral-900/50 border border-neutral-800 rounded-lg w-max">
                <button
                    onClick={() => setActiveTab('matrix')}
                    className={`px-4 py-1.5 text-xs font-medium rounded-md transition ${activeTab === 'matrix' ? 'bg-neutral-800 text-white shadow' : 'text-neutral-400 hover:text-neutral-200'}`}
                >
                    Process Matrix
                </button>
                <button
                    onClick={() => setActiveTab('settings')}
                    className={`px-4 py-1.5 text-xs font-medium rounded-md transition ${activeTab === 'settings' ? 'bg-neutral-800 text-white shadow' : 'text-neutral-400 hover:text-neutral-200'}`}
                >
                    Configuration
                </button>
            </div>

            {/* --- TAB: PROCESS MATRIX --- */}
            {activeTab === 'matrix' && (
                <>
                    <input
                        type="text"
                        placeholder="Filter active modules..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full mb-4 px-4 py-2.5 bg-neutral-900 border border-neutral-800 rounded-lg text-sm text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-neutral-700 transition"
                    />
                    <div className="flex-1 overflow-y-auto border border-neutral-800 rounded-xl bg-neutral-900/40">
                        <table className="w-full text-left text-sm border-collapse">
                            <thead>
                            <tr className="border-b border-neutral-800 text-neutral-400 text-xs font-semibold uppercase tracking-wider bg-neutral-900/80 sticky top-0 backdrop-blur-md">
                                <th className="p-4 w-12">Icon</th>
                                <th className="p-4">Process Name</th>
                                <th className="p-4 w-24">PID</th>
                                <th className="p-4 w-28 text-right">Action</th>
                            </tr>
                            </thead>
                            <tbody className="divide-y divide-neutral-900">
                            {filtered.map((proc) => {
                                const isTracked = trackedPids.includes(proc.pid);
                                return (
                                    <tr key={proc.pid} className="hover:bg-neutral-900/50 transition">
                                        <td className="p-4">
                                            {proc.icon ? (
                                                <img src={proc.icon} alt="" className="w-5 h-5 object-contain" />
                                            ) : (
                                                <div className="w-5 h-5 bg-neutral-800 rounded flex items-center justify-center text-[10px] text-neutral-500 font-bold">?</div>
                                            )}
                                        </td>
                                        <td className="p-4 font-medium text-neutral-200">{proc.name}</td>
                                        <td className="p-4 font-mono text-xs text-neutral-500">{proc.pid}</td>
                                        <td className="p-4 text-right">
                                            <button
                                                onClick={() => toggleTrack(proc.pid)}
                                                className={`px-3 py-1.5 text-xs font-medium rounded-md transition border ${
                                                    isTracked
                                                        ? 'bg-rose-950/30 border-rose-900/50 text-rose-400 hover:bg-rose-900/40'
                                                        : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:border-emerald-500/30 hover:text-emerald-400'
                                                }`}
                                            >
                                                {isTracked ? 'Untrack' : 'Track'}
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            {/* --- TAB: SETTINGS --- */}
            {activeTab === 'settings' && settings && (
                <form onSubmit={saveSettings} className="flex-1 overflow-y-auto space-y-6 pr-4">
                    <div className="grid grid-cols-2 gap-6">

                        {/* Core Settings */}
                        <div className="space-y-4">
                            <h2 className="text-sm font-semibold text-neutral-300 uppercase tracking-wider">Trigger Config</h2>
                            <div>
                                <label className="block text-xs text-neutral-500 mb-1">Global Shortcut</label>
                                <input
                                    type="text"
                                    value={settings.active_shortcut}
                                    onChange={e => setSettings({...settings, active_shortcut: e.target.value})}
                                    className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-md text-sm text-neutral-200"
                                />
                            </div>
                            <div>
                                <label className="block text-xs text-neutral-500 mb-1">Panic Mode</label>
                                <select
                                    value={settings.panic_mode}
                                    onChange={e => setSettings({...settings, panic_mode: e.target.value as UserSettings['panic_mode']})}
                                    className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-md text-sm text-neutral-200"
                                >
                                    <option value="glitch">Glitch Screenshot</option>
                                    <option value="youtube">YouTube Embed</option>
                                    <option value="local">Local Video</option>
                                    <option value="launch_app">Launch Application</option>
                                    <option value="color">Solid Color Overlay</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs text-neutral-500 mb-1">Target (URL / Path / Command)</label>
                                <input
                                    type="text"
                                    value={settings.panic_target}
                                    onChange={e => setSettings({...settings, panic_target: e.target.value})}
                                    className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-md text-sm text-neutral-200"
                                />
                            </div>
                        </div>

                        {/* Visual Settings */}
                        <div className="space-y-4">
                            <h2 className="text-sm font-semibold text-neutral-300 uppercase tracking-wider">Visual Effects</h2>
                            <div>
                                <label className="block text-xs text-neutral-500 mb-1">Overlay Color (RGBA)</label>
                                <input
                                    type="text"
                                    value={settings.panic_color}
                                    onChange={e => setSettings({...settings, panic_color: e.target.value})}
                                    className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-md text-sm text-neutral-200"
                                />
                            </div>
                            <div>
                                <label className="block text-xs text-neutral-500 mb-1">Backdrop Blur (px)</label>
                                <input
                                    type="number"
                                    value={settings.panic_blur_px}
                                    onChange={e => setSettings({...settings, panic_blur_px: parseInt(e.target.value) || 0})}
                                    className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-md text-sm text-neutral-200"
                                />
                            </div>
                            <div>
                                <label className="block text-xs text-neutral-500 mb-1">Fade Duration (ms)</label>
                                <input
                                    type="number"
                                    value={settings.panic_fade_ms}
                                    onChange={e => setSettings({...settings, panic_fade_ms: parseInt(e.target.value) || 0})}
                                    className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-md text-sm text-neutral-200"
                                />
                            </div>
                        </div>

                    </div>

                    <div className="pt-4 border-t border-neutral-800">
                        <button type="submit" className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors shadow-sm">
                            Save Configuration
                        </button>
                    </div>
                </form>
            )}
        </div>
    );
}
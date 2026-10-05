export interface Point {
  x: number;
  y: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu_usage: number;
  memory_mb: number;
  icon: string | null;
  start_time: number;
  killable: boolean;
  protection_reason: string | null;
  exe_path: string | null;
}

export interface QueuedProcess {
  pid: number;
  name: string;
  start_time: number;
}

export type PanicMode =
  | 'youtube'
  | 'local'
  | 'fade'
  | 'glitch'
  | 'launch_app'
  | 'combo';

export type ComboMode = 'fade' | 'youtube' | 'local' | 'glitch' | 'launch_app';

export interface UserSettings {
  active_shortcut: string;
  gesture_enabled: boolean;
  gesture_button: 'middle' | 'right' | 'left';
  gesture_threshold: number;
  panic_gesture: Point[];

  panic_mode: PanicMode;
  /** Legacy field retained for config migration compatibility. */
  panic_target: string;
  youtube_url: string;
  launch_app_path: string;
  local_video_path: string;
  local_video_title: string;
  local_video_start_time: number;
  panic_fade_ms: number;
  panic_color: string;
  panic_blur_px: number;
  panic_auto_close_ms: number;
  panic_hotkey_close: boolean;
  combo_modes: ComboMode[];

  saved_kill_processes: string[];
  theme: string;
}

export const PANIC_MODES: { id: PanicMode; label: string; desc: string; icon: string }[] = [
  { id: 'youtube', label: 'YouTube', desc: 'Fullscreen web video disguise', icon: '▶' },
  { id: 'local', label: 'Local Video', desc: 'Play a video from your disk', icon: '▣' },
  { id: 'fade', label: 'Color Fade', desc: 'Instant solid-color cover', icon: '◐' },
  { id: 'glitch', label: 'Glitch', desc: 'Show the desktop with interference', icon: '⌁' },
  { id: 'launch_app', label: 'Launch App', desc: 'Start a configured program', icon: '↗' },
  { id: 'combo', label: 'Combo', desc: 'Layer a disguise with visual effects', icon: '✦' },
];

export const COMBO_OPTIONS: { id: ComboMode; label: string; desc: string; icon: string }[] = [
  { id: 'fade', label: 'Color fade', desc: 'Adds a cover layer over the disguise', icon: '◐' },
  { id: 'youtube', label: 'YouTube', desc: 'Use a web video as the base', icon: '▶' },
  { id: 'local', label: 'Local video', desc: 'Use a local video as the base', icon: '▣' },
  { id: 'glitch', label: 'Glitch', desc: 'Use the pre-panic desktop image', icon: '⌁' },
  { id: 'launch_app', label: 'Launch app', desc: 'Start a companion application', icon: '↗' },
];

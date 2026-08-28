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
}

export type PanicMode =
  | 'youtube'
  | 'local'
  | 'fade'
  | 'glitch'
  | 'launch_app'
  | 'combo';

export type ComboMode = 'fade' | 'youtube' | 'glitch' | 'launch_app';

export interface UserSettings {
  active_shortcut: string;
  gesture_enabled: boolean;
  gesture_button: 'middle' | 'right' | 'left';
  gesture_threshold: number;
  panic_gesture: Point[];

  panic_mode: PanicMode;
  panic_target: string;
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

export const PANIC_MODES: { id: PanicMode; label: string; desc: string }[] = [
  { id: 'youtube', label: 'YouTube', desc: 'Fullscreen overlay playing a URL' },
  { id: 'local', label: 'Local Video', desc: 'Windowed player for a file on disk' },
  { id: 'fade', label: 'Color Fade', desc: 'Solid overlay that fades in' },
  { id: 'glitch', label: 'Glitch', desc: 'Desktop screenshot with glitch effect' },
  { id: 'launch_app', label: 'Launch App', desc: 'Spawn an app (overlay optional in combo)' },
  { id: 'combo', label: 'Combo', desc: 'Mix multiple actions together' },
];

export const COMBO_OPTIONS: { id: ComboMode; label: string }[] = [
  { id: 'fade', label: 'Color fade overlay' },
  { id: 'youtube', label: 'YouTube embed' },
  { id: 'glitch', label: 'Glitch screenshot' },
  { id: 'launch_app', label: 'Launch application' },
];

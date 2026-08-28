import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { UserSettings } from '../lib/types';

export const Route = createFileRoute('/panic')({
  component: RouteComponent,
});

function toEmbedUrl(url: string): string {
  try {
    if (url.includes('watch?v=')) {
      const v = new URL(url).searchParams.get('v');
      return `https://www.youtube.com/embed/${v}?autoplay=1&mute=0`;
    }
    if (url.includes('youtu.be/')) {
      const v = url.split('youtu.be/')[1].split('?')[0];
      return `https://www.youtube.com/embed/${v}?autoplay=1&mute=0`;
    }
    if (!url.includes('autoplay=1')) {
      return url + (url.includes('?') ? '&' : '?') + 'autoplay=1';
    }
  } catch {
    /* keep original */
  }
  return url;
}

function activeModes(settings: UserSettings): Set<string> {
  if (settings.panic_mode === 'combo') {
    return new Set(settings.combo_modes);
  }
  return new Set([settings.panic_mode]);
}

function RouteComponent() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [stage, setStage] = useState<'enter' | 'active' | 'exit'>('enter');

  const closeOverlay = useCallback(async () => {
    setStage('exit');
    setTimeout(async () => {
      await invoke('close_panic');
    }, 1000);
  }, []);

  useEffect(() => {
    async function init() {
      const s = await invoke<UserSettings>('get_settings');
      setSettings(s);
      const modes = activeModes(s);

      if (modes.has('glitch')) {
        const img = await invoke<string | null>('get_last_screenshot');
        if (img) setScreenshot(img);
      }

      requestAnimationFrame(() => setStage('active'));

      const isMedia =
        s.panic_mode === 'local' ||
        s.panic_mode === 'youtube' ||
        (s.panic_mode === 'combo' && s.combo_modes.includes('youtube'));

      if (s.panic_auto_close_ms > 0) {
        setTimeout(closeOverlay, s.panic_auto_close_ms);
      } else if (!isMedia && s.panic_mode !== 'local') {
        const holdMs = s.panic_fade_ms + 800;
        setTimeout(() => {
          if (s.panic_mode === 'fade' || s.panic_mode === 'launch_app') {
            closeOverlay();
          } else if (s.panic_mode === 'combo' && !s.combo_modes.includes('youtube')) {
            closeOverlay();
          } else if (s.panic_mode === 'glitch') {
            closeOverlay();
          }
        }, holdMs);
      }
    }
    init();
  }, [closeOverlay]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeOverlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeOverlay]);

  if (!settings) return null;

  const modes = activeModes(settings);
  const showYoutube =
    modes.has('youtube') && settings.panic_target.trim() !== '';
  const showGlitch = modes.has('glitch') && screenshot;
  const showFade =
    modes.has('fade') ||
    settings.panic_mode === 'fade' ||
    (settings.panic_mode === 'launch_app' && settings.combo_modes.length === 0);
  const isLocal = settings.panic_mode === 'local';
  const fadeMs = settings.panic_fade_ms;

  return (
    <>
      <style>{`
        @keyframes glitch-anim {
          0%   { clip-path: inset(20% 0 80% 0); transform: translate(-3px, 3px); }
          25%  { clip-path: inset(60% 0 10% 0); transform: translate(3px, -3px); }
          50%  { clip-path: inset(40% 0 50% 0); transform: translate(3px, 3px); }
          75%  { clip-path: inset(80% 0 5% 0);  transform: translate(-3px, -3px); }
          100% { clip-path: inset(30% 0 50% 0); transform: translate(-3px, 3px); }
        }
        .glitch-a { animation: glitch-anim 0.12s ease-in-out infinite; }
        .glitch-b { animation: glitch-anim 0.2s ease-in-out reverse infinite; }
      `}</style>

      <div
        className={`relative w-screen h-screen overflow-hidden ${
          stage === 'enter'
            ? 'panic-overlay-enter opacity-0'
            : stage === 'exit'
              ? 'panic-overlay-exit'
              : 'opacity-100'
        }`}
        style={
          {
            '--panic-fade-ms': `${fadeMs}ms`,
            backgroundColor: isLocal ? '#000' : settings.panic_color,
            backdropFilter: isLocal
              ? 'none'
              : `blur(${settings.panic_blur_px}px)`,
            WebkitBackdropFilter: isLocal
              ? 'none'
              : `blur(${settings.panic_blur_px}px)`,
          } as React.CSSProperties
        }
        onClick={!isLocal && !showYoutube ? closeOverlay : undefined}
      >
        {showGlitch && (
          <div className="absolute inset-0">
            <img
              src={screenshot}
              alt=""
              className="absolute inset-0 w-full h-full object-cover grayscale contrast-[1.15] brightness-90"
            />
            <img
              src={screenshot}
              alt=""
              className="glitch-a absolute inset-0 w-full h-full object-cover opacity-70 mix-blend-screen"
              style={{ filter: 'hue-rotate(90deg)' }}
            />
            <img
              src={screenshot}
              alt=""
              className="glitch-b absolute inset-0 w-full h-full object-cover opacity-70 mix-blend-screen translate-x-2"
              style={{ filter: 'hue-rotate(-90deg)' }}
            />
            <div className="absolute inset-0 bg-black/20 pointer-events-none" />
          </div>
        )}

        {showYoutube && (
          <iframe
            src={toEmbedUrl(settings.panic_target)}
            allow="autoplay; encrypted-media; fullscreen"
            className="absolute inset-0 w-full h-full border-none z-10"
            title="video"
          />
        )}

        {isLocal && settings.local_video_path && (
          <video
            src={settings.local_video_path}
            autoPlay
            controls
            onLoadedMetadata={(e) => {
              e.currentTarget.currentTime =
                settings.local_video_start_time || 0;
            }}
            className="absolute inset-0 w-full h-full object-contain z-10"
          />
        )}

        {showFade && !showYoutube && !showGlitch && !isLocal && (
          <div className="absolute inset-0" />
        )}

        {!isLocal && !showYoutube && (
          <button
            onClick={closeOverlay}
            className="absolute top-4 right-4 z-50 w-8 h-8 flex items-center justify-center rounded-full bg-black/30 hover:bg-black/50 text-white/60 hover:text-white text-lg transition-all cursor-pointer backdrop-blur-sm border border-white/10"
            aria-label="Close"
          >
            ×
          </button>
        )}
      </div>
    </>
  );
}

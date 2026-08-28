import { createFileRoute } from '@tanstack/react-router';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { UserSettings } from '../lib/types';

export const Route = createFileRoute('/panic')({
  component: RouteComponent,
});

const EXIT_MS = 320;

function activeModes(settings: UserSettings): Set<string> {
  return settings.panic_mode === 'combo'
      ? new Set(settings.combo_modes)
      : new Set([settings.panic_mode]);
}

function toEmbedUrl(rawUrl: string): string {
  const value = rawUrl.trim();
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let videoId = '';

    if (host === 'youtu.be') {
      videoId = url.pathname.split('/').filter(Boolean)[0] ?? '';
    } else if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (url.pathname === '/watch') {
        videoId = url.searchParams.get('v') ?? '';
      } else if (url.pathname.startsWith('/shorts/')) {
        videoId = url.pathname.split('/')[2] ?? '';
      } else if (url.pathname.startsWith('/embed/')) {
        videoId = url.pathname.split('/')[2] ?? '';
      }
    }

    if (videoId) {
      return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&playsinline=1&controls=0&rel=0&modestbranding=1`;
    }
  } catch {
    // Leave unknown URLs alone; the iframe will handle its own failure.
  }

  return value;
}

function localVideoUrl(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return '';
  try {
    return convertFileSrc(trimmed);
  } catch {
    return trimmed;
  }
}

function RouteComponent() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [stage, setStage] = useState<'enter' | 'active' | 'exit'>('enter');
  const [mediaError, setMediaError] = useState(false);
  const closingRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  }, []);

  const closeOverlay = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    clearTimers();
    setStage('exit');
    window.setTimeout(() => {
      void invoke('close_panic').catch((error) => {
        console.error('[guiso] failed to close panic overlay', error);
      });
    }, EXIT_MS);
  }, [clearTimers]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const loaded = await invoke<UserSettings>('get_settings');
        if (cancelled) return;
        setSettings(loaded);

        const modes = activeModes(loaded);
        if (modes.has('glitch')) {
          const image = await invoke<string | null>('get_last_screenshot');
          if (!cancelled) setScreenshot(image);
        }

        requestAnimationFrame(() => {
          if (!cancelled) setStage('active');
        });

        const hasPersistentMedia = modes.has('youtube') || modes.has('local');
        const hardClose =
            loaded.panic_auto_close_ms > 0
                ? loaded.panic_auto_close_ms
                : hasPersistentMedia
                    ? 0
                    : loaded.panic_fade_ms + 1_000;

        if (hardClose > 0) {
          const exitTimer = window.setTimeout(
              () => void closeOverlay(),
              Math.max(0, hardClose - EXIT_MS),
          );
          timersRef.current.push(exitTimer);
        }
      } catch (error) {
        console.error('[guiso] failed to initialize panic overlay', error);
        // Still cover the screen even if the settings IPC call fails.
        requestAnimationFrame(() => setStage('active'));
      }
    }

    void init();
    return () => {
      cancelled = true;
      clearTimers();
    };
  }, [clearTimers, closeOverlay]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void closeOverlay();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeOverlay]);

  const modes = useMemo(() => (settings ? activeModes(settings) : new Set<string>()), [settings]);
  const youtubeVisible = Boolean(settings && modes.has('youtube') && settings.youtube_url.trim());
  const localVisible = Boolean(settings && modes.has('local') && settings.local_video_path.trim());
  const glitchVisible = Boolean(settings && modes.has('glitch') && screenshot);
  const fadeVisible = modes.has('fade');
  const localSrc = settings ? localVideoUrl(settings.local_video_path) : '';
  const youtubeSrc = settings ? toEmbedUrl(settings.youtube_url) : '';

  if (!settings) {
    return (
        <div className="fixed inset-0 bg-black" aria-hidden="true" />
    );
  }

  const background = settings.panic_color || 'rgba(15,15,15,0.97)';

  return (
      <div
          className={`fixed inset-0 overflow-hidden bg-black text-white ${
              stage === 'enter'
                  ? 'panic-overlay-enter'
                  : stage === 'exit'
                      ? 'panic-overlay-exit'
                      : 'panic-overlay-active'
          }`}
          style={{
            backgroundColor: background,
            backdropFilter: `blur(${settings.panic_blur_px}px)`,
            WebkitBackdropFilter: `blur(${settings.panic_blur_px}px)`,
          }}
          role="presentation"
      >
        <style>{`
        @keyframes panic-in {
          from { opacity: 0; transform: scale(1.012); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes panic-out {
          from { opacity: 1; transform: scale(1); }
          to { opacity: 0; transform: scale(1.01); }
        }
        @keyframes glitch-anim {
          0%   { clip-path: inset(20% 0 80% 0); transform: translate(-4px, 2px); }
          20%  { clip-path: inset(60% 0 10% 0); transform: translate(4px, -2px); }
          40%  { clip-path: inset(40% 0 50% 0); transform: translate(2px, 3px); }
          60%  { clip-path: inset(80% 0 5% 0); transform: translate(-3px, -1px); }
          80%  { clip-path: inset(30% 0 50% 0); transform: translate(1px, 4px); }
          100% { clip-path: inset(20% 0 80% 0); transform: translate(-4px, 2px); }
        }
        .panic-overlay-enter { animation: panic-in var(--panic-fade-ms) ease-out both; }
        .panic-overlay-active { opacity: 1; }
        .panic-overlay-exit { animation: panic-out ${EXIT_MS}ms ease-in both; pointer-events: none; }
        .glitch-a { animation: glitch-anim 0.12s steps(2, end) infinite; }
        .glitch-b { animation: glitch-anim 0.19s steps(2, end) reverse infinite; }
      `}</style>

        <div
            className="absolute inset-0"
            style={{ '--panic-fade-ms': `${Math.max(0, settings.panic_fade_ms)}ms` } as CSSProperties}
        />

        {glitchVisible && (
            <div className="absolute inset-0 z-10 overflow-hidden">
              <img
                  src={screenshot ?? ''}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover grayscale contrast-[1.15] brightness-90"
              />
              <img
                  src={screenshot ?? ''}
                  alt=""
                  className="glitch-a absolute inset-0 h-full w-full object-cover opacity-65 mix-blend-screen"
                  style={{ filter: 'hue-rotate(85deg) saturate(1.35)' }}
              />
              <img
                  src={screenshot ?? ''}
                  alt=""
                  className="glitch-b absolute inset-0 h-full w-full object-cover opacity-60 mix-blend-screen"
                  style={{ filter: 'hue-rotate(-85deg) saturate(1.35)' }}
              />
              <div className="absolute inset-0 bg-black/25" />
            </div>
        )}

        {localVisible && !mediaError && (
            <video
                src={localSrc}
                autoPlay
                playsInline
                loop
                onError={() => setMediaError(true)}
                onLoadedMetadata={(event) => {
                  const start = Math.max(0, settings.local_video_start_time || 0);
                  if (start < event.currentTarget.duration) {
                    event.currentTarget.currentTime = start;
                  }
                  void event.currentTarget.play().catch(() => undefined);
                }}
                className="absolute inset-0 z-20 h-full w-full object-cover bg-black"
            />
        )}

        {youtubeVisible && !mediaError && (
            <iframe
                src={youtubeSrc}
                allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                className="absolute inset-0 z-20 h-full w-full border-0"
                title="Disguise video"
            />
        )}

        {(fadeVisible || (!youtubeVisible && !localVisible && !glitchVisible)) && (
            <div
                className="absolute inset-0 z-15"
                style={{ backgroundColor: background }}
            />
        )}

        {mediaError && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/90 px-8 text-center">
              <div>
                <div className="text-sm font-semibold text-white">Disguise media could not be played</div>
                <div className="mt-1 text-xs text-white/50">The protective cover is still active.</div>
              </div>
            </div>
        )}

        <button
            type="button"
            onClick={() => void closeOverlay()}
            className="absolute right-5 top-5 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/35 text-xl text-white/70 shadow-lg backdrop-blur-md transition hover:bg-black/60 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/40"
            aria-label="Close disguise"
        >
          ×
        </button>
      </div>
  );
}
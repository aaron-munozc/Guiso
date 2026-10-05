import { createFileRoute } from '@tanstack/react-router';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { PanicMode, UserSettings } from '../lib/types';

export const Route = createFileRoute('/panic')({
  component: RouteComponent,
});

const EXIT_MS = 320;
const BOOT_RECOVERY_MS = 1200;
const MEDIA_READY_TIMEOUT_MS = 8000;
const GLITCH_HOLD_MS = 520;
const MIN_FADE_MS = 160;

type LayerRefs = {
  root: HTMLDivElement | null;
  visual: HTMLDivElement | null;
};

function activeModes(settings: UserSettings): Set<PanicMode> {
  return settings.panic_mode === 'combo'
    ? new Set(settings.combo_modes)
    : new Set([settings.panic_mode]);
}

function toEmbedUrl(rawUrl: string): string {
  const value = rawUrl.trim();
  if (!value) return '';

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
        videoId = url.pathname.split('/').filter(Boolean)[1] ?? '';
      } else if (url.pathname.startsWith('/embed/')) {
        videoId = url.pathname.split('/').filter(Boolean)[1] ?? '';
      }
    }

    if (videoId) {
      const params = new URLSearchParams({
        autoplay: '1',
        playsinline: '1',
        controls: '0',
        rel: '0',
        modestbranding: '1',
        iv_load_policy: '3',
        fs: '0',
        disablekb: '1',
      });
      return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${params}`;
    }
  } catch {
    // Leave unknown URLs alone and let the iframe handle them.
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

function hasPersistentMedia(settings: UserSettings, modes: Set<PanicMode>) {
  return (
    (modes.has('youtube') && settings.youtube_url.trim().length > 0) ||
    (modes.has('local') && settings.local_video_path.trim().length > 0)
  );
}

function easeInOut(t: number) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

function RouteComponent() {
  const rootRef = useRef<HTMLDivElement>(null);
  const visualRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const animationRef = useRef<number | null>(null);
  const visualDissolvedRef = useRef(false);
  const mediaReadyRef = useRef(false);
  const timersRef = useRef<number[]>([]);
  const lifecycleRef = useRef<LayerRefs>({ root: null, visual: null });

  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootSlow, setBootSlow] = useState(false);
  const [localError, setLocalError] = useState(false);
  const [youtubeError, setYoutubeError] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const [isPreview] = useState(
    () => new URLSearchParams(window.location.search).get('preview') === '1',
  );

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
  }, []);

  const stopAnimation = useCallback(() => {
    if (animationRef.current !== null) {
      window.cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  const nativeClose = useCallback(async () => {
    try {
      await getCurrentWebviewWindow().close();
    } catch (error) {
      console.error('[guiso] native overlay close failed', error);
    }
  }, []);

  const finishClose = useCallback(async () => {
    try {
      await invoke('close_panic');
    } catch (error) {
      console.error('[guiso] close_panic IPC failed; using native close fallback', error);
      await nativeClose();
    }
  }, [nativeClose]);

  const animateOpacity = useCallback(
    (element: HTMLElement | null, from: number, to: number, duration: number, done?: () => void) => {
      if (!element) {
        done?.();
        return;
      }

      stopAnimation();
      const start = performance.now();
      const span = Math.max(1, duration);
      element.style.opacity = `${from}`;

      const tick = (now: number) => {
        const progress = Math.min(1, (now - start) / span);
        element.style.opacity = `${from + (to - from) * easeInOut(progress)}`;
        if (progress < 1) {
          animationRef.current = window.requestAnimationFrame(tick);
          return;
        }
        animationRef.current = null;
        done?.();
      };

      animationRef.current = window.requestAnimationFrame(tick);
    },
    [stopAnimation],
  );

  const closeOverlay = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    clearTimers();

    const root = lifecycleRef.current.root;
    if (!root) {
      await nativeClose();
      return;
    }

    animateOpacity(root, 1, 0, EXIT_MS, () => void finishClose());
  }, [animateOpacity, clearTimers, finishClose, nativeClose]);

  const fadeVisualAndFinish = useCallback(
    (settingsForFade: UserSettings, shouldClose: boolean) => {
      if (visualDissolvedRef.current) {
        if (shouldClose && !closingRef.current) void closeOverlay();
        return;
      }

      visualDissolvedRef.current = true;
      const visual = lifecycleRef.current.visual;
      const duration = Math.max(MIN_FADE_MS, settingsForFade.panic_fade_ms);
      if (!visual) {
        if (shouldClose) void closeOverlay();
        return;
      }

      animateOpacity(visual, 1, 0, duration, () => {
        if (shouldClose) {
          void closeOverlay();
        }
      });
    },
    [animateOpacity, closeOverlay],
  );

  useEffect(() => {
    lifecycleRef.current.root = rootRef.current;
    lifecycleRef.current.visual = visualRef.current;
    return () => {
      lifecycleRef.current.root = null;
      lifecycleRef.current.visual = null;
    };
  });

  useEffect(() => {
    rootRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      void closeOverlay();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [closeOverlay]);

  useEffect(() => {
    visualDissolvedRef.current = false;
    mediaReadyRef.current = false;
    let cancelled = false;
    const slowTimer = window.setTimeout(() => {
      if (!cancelled) setBootSlow(true);
    }, BOOT_RECOVERY_MS);
    timersRef.current.push(slowTimer);

    async function init() {
      try {
        const loaded = await invoke<UserSettings>('get_settings');
        if (cancelled) return;

        window.clearTimeout(slowTimer);
        setBootSlow(false);
        setSettings(loaded);

        const modes = activeModes(loaded);
        let image: string | null = null;
        if (modes.has('glitch')) {
          image = await invoke<string | null>('get_last_screenshot');
          if (!cancelled) setScreenshot(image);
        }

        requestAnimationFrame(() => rootRef.current?.focus());

        const persistentMedia = hasPersistentMedia(loaded, modes);
        const hasGlitchVisual = modes.has('glitch') && Boolean(image);

        if (isPreview) {
          timersRef.current.push(
            window.setTimeout(() => {
              fadeVisualAndFinish(loaded, true);
            }, 10_000),
          );
        } else if (persistentMedia) {
          // Keep the cover in place while media loads. If the media runtime
          // never reports ready, the timeout releases the cover as a fail-safe.
          timersRef.current.push(
            window.setTimeout(() => {
              if (!mediaReadyRef.current) {
                fadeVisualAndFinish(loaded, false);
              }
            }, MEDIA_READY_TIMEOUT_MS),
          );
        } else if (hasGlitchVisual) {
          // Let the pre-panic snapshot be visible briefly before dissolving it.
          timersRef.current.push(
            window.setTimeout(() => {
              fadeVisualAndFinish(loaded, true);
            }, GLITCH_HOLD_MS),
          );
        } else {
          // Pure fade / fallback cover: begin the dissolve on the next frame.
          timersRef.current.push(
            window.setTimeout(() => {
              fadeVisualAndFinish(loaded, true);
            }, 40),
          );
        }
      } catch (error) {
        console.error('[guiso] failed to initialize panic overlay', error);
        if (!cancelled) {
          setBootError('The panic configuration could not be loaded.');
          requestAnimationFrame(() => rootRef.current?.focus());
        }
      }
    }

    void init();
    return () => {
      cancelled = true;
      window.clearTimeout(slowTimer);
      clearTimers();
      stopAnimation();
    };
  }, [clearTimers, fadeVisualAndFinish, isPreview, stopAnimation]);

  useEffect(() => {
    mediaReadyRef.current = mediaReady;
    if (!settings || !mediaReady || isPreview) return;
    const modes = activeModes(settings);
    if (!hasPersistentMedia(settings, modes)) return;

    // Media is now genuinely available: dissolve the initial cover.
    fadeVisualAndFinish(settings, false);
  }, [fadeVisualAndFinish, isPreview, mediaReady, settings]);

  useEffect(() => {
    return () => {
      clearTimers();
      stopAnimation();
    };
  }, [clearTimers, stopAnimation]);

  const modes = useMemo(
    () => (settings ? activeModes(settings) : new Set<PanicMode>()),
    [settings],
  );

  const youtubeConfigured = Boolean(settings?.youtube_url.trim());
  const localConfigured = Boolean(settings?.local_video_path.trim());
  const youtubeVisible = modes.has('youtube') && youtubeConfigured && !youtubeError;
  const localVisible = modes.has('local') && localConfigured && !localError;
  const glitchVisible = modes.has('glitch') && Boolean(screenshot);
  const persistentMedia = Boolean(settings && hasPersistentMedia(settings, modes));
  const localSrc = settings ? localVideoUrl(settings.local_video_path) : '';
  const youtubeSrc = settings ? toEmbedUrl(settings.youtube_url) : '';
  const background = settings?.panic_color || 'rgba(8, 7, 6, 1)';
  const blurPx = settings?.panic_blur_px ?? 0;

  const rootStyle = {
    '--panic-background': background,
    '--panic-blur': `${blurPx}px`,
  } as CSSProperties;

  if (!settings) {
    return (
      <div
        ref={rootRef}
        tabIndex={-1}
        className="panic-root"
        style={{ background: 'transparent' }}
        role="presentation"
      >
        <style>{`
          html, body, #root { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent !important; }
          .panic-root { position: fixed; inset: 0; outline: none; background: transparent; }
        `}</style>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="panic-root"
      style={rootStyle}
      role="presentation"
      onContextMenu={(event) => event.preventDefault()}
    >
      <style>{`
        html, body, #root {
          width: 100%;
          height: 100%;
          margin: 0;
          overflow: hidden;
          background: transparent !important;
        }

        *, *::before, *::after { box-sizing: border-box; }

        .panic-root {
          position: fixed;
          inset: 0;
          overflow: hidden;
          isolation: isolate;
          outline: none;
          background: transparent;
          color: white;
          user-select: none;
          -webkit-user-select: none;
        }

        .panic-media-layer {
          position: absolute;
          inset: 0;
          z-index: 10;
          background: transparent;
        }

        .panic-visual-layer {
          position: absolute;
          inset: 0;
          z-index: 30;
          background: transparent;
          will-change: opacity;
          pointer-events: none;
        }

        .panic-cover {
          position: absolute;
          inset: 0;
          background: var(--panic-background);
          backdrop-filter: blur(var(--panic-blur));
          -webkit-backdrop-filter: blur(var(--panic-blur));
        }

        .panic-glitch {
          position: absolute;
          inset: 0;
          overflow: hidden;
          background: #000;
        }

        @keyframes glitch-shift {
          0% { clip-path: inset(10% 0 82% 0); transform: translate(-3px, 1px); }
          18% { clip-path: inset(60% 0 18% 0); transform: translate(4px, -2px); }
          36% { clip-path: inset(38% 0 46% 0); transform: translate(2px, 2px); }
          54% { clip-path: inset(78% 0 7% 0); transform: translate(-2px, -1px); }
          72% { clip-path: inset(24% 0 58% 0); transform: translate(1px, 3px); }
          100% { clip-path: inset(10% 0 82% 0); transform: translate(-3px, 1px); }
        }

        @keyframes scanline {
          from { transform: translateY(-100%); }
          to { transform: translateY(100vh); }
        }

        .glitch-layer-a { animation: glitch-shift .12s steps(2, end) infinite; }
        .glitch-layer-b { animation: glitch-shift .18s steps(2, end) reverse infinite; }
        .scanline { animation: scanline 3.5s linear infinite; }
      `}</style>

      <div className="panic-media-layer">
        {localVisible && (
          <video
            src={localSrc}
            autoPlay
            playsInline
            loop
            muted={false}
            onCanPlay={() => setMediaReady(true)}
            onError={() => setLocalError(true)}
            onLoadedMetadata={(event) => {
              const start = Math.max(0, settings.local_video_start_time ?? 0);
              if (Number.isFinite(event.currentTarget.duration) && start < event.currentTarget.duration) {
                event.currentTarget.currentTime = start;
              }
              void event.currentTarget.play().catch(() => undefined);
            }}
            className="pointer-events-none absolute inset-0 h-full w-full object-cover bg-black"
          />
        )}

        {youtubeVisible && (
          <iframe
            src={youtubeSrc}
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            onLoad={() => {
              window.setTimeout(() => setMediaReady(true), 350);
            }}
            onError={() => setYoutubeError(true)}
            className="pointer-events-none absolute inset-0 h-full w-full border-0 bg-transparent"
            title="Panic media"
            tabIndex={-1}
          />
        )}
      </div>

      <div ref={visualRef} className="panic-visual-layer">
        <div className="panic-cover" />

        {glitchVisible && (
          <div className="panic-glitch">
            <img
              src={screenshot ?? ''}
              alt=""
              className="absolute inset-[-2%] h-[104%] w-[104%] object-cover grayscale contrast-[1.12] brightness-[0.9]"
              style={{ filter: `blur(${blurPx}px) grayscale(1) contrast(1.12) brightness(.9)` }}
            />
            <img
              src={screenshot ?? ''}
              alt=""
              className="glitch-layer-a absolute inset-[-2%] h-[104%] w-[104%] object-cover opacity-70 mix-blend-screen"
              style={{ filter: 'hue-rotate(85deg) saturate(1.35)' }}
            />
            <img
              src={screenshot ?? ''}
              alt=""
              className="glitch-layer-b absolute inset-[-2%] h-[104%] w-[104%] object-cover opacity-60 mix-blend-screen"
              style={{ filter: 'hue-rotate(-85deg) saturate(1.35)' }}
            />
            <div className="absolute inset-0 bg-black/20" />
            <div className="scanline absolute -top-full left-0 h-1/2 w-full bg-gradient-to-b from-transparent via-white/[0.035] to-transparent" />
            <div className="absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(255,255,255,.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.018)_1px,transparent_1px)] [background-size:4px_4px]" />
          </div>
        )}
      </div>

      {!persistentMedia && !glitchVisible && !localVisible && !youtubeVisible && !bootError && (
        <div className="pointer-events-none absolute inset-0 z-40" />
      )}

      {(localError || youtubeError) && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-black/70 px-8 text-center">
          <div className="max-w-sm rounded-2xl border border-white/10 bg-black/55 px-6 py-5 shadow-2xl backdrop-blur-xl">
            <div className="text-sm font-semibold text-white">Panic media unavailable</div>
            <div className="mt-1 text-xs leading-relaxed text-white/50">
              The visual cover can still complete normally. Press Escape to close it.
            </div>
          </div>
        </div>
      )}

      {isPreview && (
        <div className="pointer-events-none absolute left-5 top-5 z-[60] rounded-full border border-white/15 bg-black/35 px-3 py-1.5 text-[9px] font-black uppercase tracking-[0.14em] text-white/55 backdrop-blur-md">
          Preview · no cleanup
        </div>
      )}

      {bootError && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[60] flex justify-center px-4 pt-6">
          <div className="max-w-md rounded-2xl border border-white/10 bg-black/65 px-5 py-4 text-center shadow-2xl backdrop-blur-xl">
            <p className="text-sm font-semibold text-white">Panic recovery mode</p>
            <p className="mt-1 text-xs text-white/55">Press Escape to close safely.</p>
          </div>
        </div>
      )}

      {bootSlow && !bootError && (
        <div className="pointer-events-none absolute bottom-5 left-5 z-[60] rounded-full border border-white/10 bg-black/45 px-3 py-1.5 text-[10px] font-medium text-white/50 shadow-lg backdrop-blur-md">
          Press Esc to exit
        </div>
      )}
    </div>
  );
}

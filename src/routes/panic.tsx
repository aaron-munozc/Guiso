import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export const Route = createFileRoute('/panic')({
  component: RouteComponent,
});

interface UserSettings {
  panic_mode: 'youtube' | 'local' | 'color' | 'launch_app' | 'glitch';
  panic_target: string;
  panic_fade_ms: number;
  panic_color: string;
  panic_blur_px: number;
}

function RouteComponent() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [stage, setStage] = useState<'active' | 'fading'>('active');

  useEffect(() => {
    async function init() {
      const s = await invoke<UserSettings>('get_settings');
      setSettings(s);

      if (s.panic_mode === 'glitch') {
        const img = await invoke<string>('get_last_screenshot');
        setScreenshot(img);
      }

      // Trigger the fade-out after the designated duration
      setTimeout(() => {
        setStage('fading');
        setTimeout(() => {
          getCurrentWebviewWindow().close();
        }, 1200); // 1.2s smooth exit animation
      }, s.panic_fade_ms);
    }
    init();
  }, []);

  if (!settings) return null;

  return (
      <>
        <style>{`
        @keyframes glitch-anim {
          0% { clip-path: inset(20% 0 80% 0); transform: translate(-4px, 4px); }
          20% { clip-path: inset(60% 0 10% 0); transform: translate(4px, -4px); }
          40% { clip-path: inset(40% 0 50% 0); transform: translate(4px, 4px); }
          60% { clip-path: inset(80% 0 5% 0); transform: translate(-4px, -4px); }
          80% { clip-path: inset(10% 0 70% 0); transform: translate(4px, 4px); }
          100% { clip-path: inset(30% 0 50% 0); transform: translate(-4px, -4px); }
        }
        .glitch-layer {
          animation: glitch-anim 0.15s cubic-bezier(.25, .46, .45, .94) both infinite;
        }
        .glitch-layer-2 {
          animation: glitch-anim 0.25s cubic-bezier(.25, .46, .45, .94) reverse infinite;
        }
      `}</style>

        {/* The primary wrapper.
        Note the use of settings.panic_blur_px for custom backdrop blurring over the transparent Tauri window.
      */}
        <div
            className={`relative w-screen h-screen overflow-hidden transition-all duration-1200 ease-in-out ${
                stage === 'fading' ? 'opacity-0 scale-105' : 'opacity-100 scale-100'
            }`}
            style={{
              backgroundColor: settings.panic_color,
              backdropFilter: `blur(${settings.panic_blur_px}px)`,
              WebkitBackdropFilter: `blur(${settings.panic_blur_px}px)`
            }}
        >

          {settings.panic_mode === 'glitch' && screenshot && (
              <div className="absolute inset-0 w-full h-full">
                <img src={screenshot} className="absolute inset-0 w-full h-full object-cover filter grayscale contrast-[1.2] brightness-90" />
                <img src={screenshot} className="glitch-layer absolute inset-0 w-full h-full object-cover opacity-80 mix-blend-screen" style={{ filter: 'hue-rotate(90deg)' }}/>
                <img src={screenshot} className="glitch-layer-2 absolute inset-0 w-full h-full object-cover opacity-80 mix-blend-screen transform translate-x-3" style={{ filter: 'hue-rotate(-90deg)' }} />
                <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0IiBoZWlnaHQ9IjQiPjxyZWN0IHdpZHRoPSI0IiBoZWlnaHQ9IjQiIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wNSIvPjwvc3ZnPg==')] opacity-40 pointer-events-none mix-blend-overlay"></div>
              </div>
          )}

          {settings.panic_mode === 'youtube' && (
              <iframe
                  src={settings.panic_target}
                  allow="autoplay; encrypted-media"
                  className="w-full h-full border-none shadow-2xl"
              />
          )}

          {settings.panic_mode === 'local' && (
              <video
                  src={settings.panic_target}
                  autoPlay
                  muted
                  className="w-full h-full object-cover"
              />
          )}
        </div>
      </>
  );
}
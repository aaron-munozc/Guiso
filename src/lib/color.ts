export interface ParsedRgba {
  hex: string;
  alpha: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function parseRgba(value: string): ParsedRgba {
  const match = value
      .trim()
      .match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);

  if (!match) return { hex: '#0F0F0F', alpha: 0.97 };

  const r = clamp(Number(match[1]), 0, 255);
  const g = clamp(Number(match[2]), 0, 255);
  const b = clamp(Number(match[3]), 0, 255);
  const alpha = clamp(match[4] === undefined ? 1 : Number(match[4]), 0, 1);

  const hex = `#${[r, g, b]
      .map((channel) => channel.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()}`;

  return { hex, alpha };
}

export function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.trim();
  let r = 15;
  let g = 15;
  let b = 15;

  if (/^#[0-9a-fA-F]{3}$/.test(normalized)) {
    r = parseInt(normalized[1] + normalized[1], 16);
    g = parseInt(normalized[2] + normalized[2], 16);
    b = parseInt(normalized[3] + normalized[3], 16);
  } else if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    r = parseInt(normalized.slice(1, 3), 16);
    g = parseInt(normalized.slice(3, 5), 16);
    b = parseInt(normalized.slice(5, 7), 16);
  }

  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1).toFixed(2)})`;
}
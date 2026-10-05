export interface ParsedRgba {
  hex: string;
  alpha: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function byte(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 255) : 15;
}

function alphaValue(value: string | undefined) {
  if (value === undefined) return 1;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 1) : 1;
}

export function parseRgba(value: string): ParsedRgba {
  const input = value.trim();

  const rgba = input.match(
    /^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i,
  );

  if (rgba) {
    const alpha = rgba[4]?.endsWith('%')
      ? clamp(Number.parseFloat(rgba[4]) / 100, 0, 1)
      : alphaValue(rgba[4]);
    return {
      hex: `#${[rgba[1], rgba[2], rgba[3]]
        .map(byte)
        .map((channel) => channel.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()}`,
      alpha,
    };
  }

  if (/^#[0-9a-f]{3}$/i.test(input)) {
    return {
      hex: `#${input
        .slice(1)
        .split('')
        .map((channel) => channel + channel)
        .join('')
        .toUpperCase()}`,
      alpha: 1,
    };
  }

  if (/^#[0-9a-f]{6}$/i.test(input)) {
    return { hex: input.toUpperCase(), alpha: 1 };
  }

  return { hex: '#0F0F0F', alpha: 0.97 };
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

export function parseRgba(rgba: string) {
  const match = rgba.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (!match) return { hex: '#0f0f0f', alpha: 0.97 };
  const r = parseInt(match[1]);
  const g = parseInt(match[2]);
  const b = parseInt(match[3]);
  const a = match[4] ? parseFloat(match[4]) : 1;
  const hex =
    '#' +
    (1 << 24 | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase();
  return { hex, alpha: a };
}

export function hexToRgba(hex: string, alpha: number) {
  let r = 0,
    g = 0,
    b = 0;
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

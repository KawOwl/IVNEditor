/**
 * Anthropic-inspired design tokens for the visual novel engine.
 * Warm dark palette with terracotta accent, adapted from anthropic.com.
 */

export const T = {
  // Backgrounds
  bg: '#1a1816',
  bgSurface: '#242220',
  bgElevated: '#2e2b28',
  bgOverlay: 'rgba(0, 0, 0, 0.7)',

  // Borders
  border: 'rgba(255,255,255,0.06)',
  borderSubtle: 'rgba(255,255,255,0.03)',
  borderStrong: 'rgba(255,255,255,0.12)',

  // Text
  textPrimary: '#f5f0e8',
  textSecondary: '#a89f94',
  textTertiary: '#6b6560',
  textMuted: '#4a4542',

  // Accent (Anthropic terracotta)
  accent: '#d97757',
  accentMuted: 'rgba(217, 119, 87, 0.15)',
  accentBorder: 'rgba(217, 119, 87, 0.3)',
  accentText: '#e8956e',

  // Semantic
  success: '#6b9e78',
  successMuted: 'rgba(107, 158, 120, 0.15)',
  error: '#c75050',
  errorMuted: 'rgba(199, 80, 80, 0.12)',
  info: '#8ba4b8',
  infoMuted: 'rgba(139, 164, 184, 0.12)',

  // Special
  gold: '#c4956a',
  narration: '#8a8078',
  speaker: '#d97757',

  // Typography
  fontSerif: '"Noto Serif SC", "Source Han Serif CN", Georgia, serif',
  fontSans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontMono: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, monospace',

  // Radii
  radius: '6px',
  radiusLg: '10px',
  radiusPill: '100px',
} as const;

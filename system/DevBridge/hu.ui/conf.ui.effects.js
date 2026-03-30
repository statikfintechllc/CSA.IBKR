// conf.ui.effects.js — SFTi DevBridge Visual Effects Configuration
// All tunable parameters for the UI live here. ui.js reads this on init.

export const FX = {

  // ── Color Palette ──────────────────────────────────────────────────────────
  colors: {
    bg:           '#04050d',
    surface:      'rgba(10, 14, 30, 0.72)',
    border:       'rgba(0, 245, 200, 0.12)',
    primary:      '#00f5c8',
    primaryDim:   'rgba(0, 245, 200, 0.18)',
    primaryGlow:  'rgba(0, 245, 200, 0.45)',
    secondary:    '#ff9500',
    secondaryDim: 'rgba(255, 149, 0, 0.18)',
    danger:       '#ff3b5c',
    dangerDim:    'rgba(255, 59, 92, 0.18)',
    info:         '#5eb8ff',
    infoDim:      'rgba(94, 184, 255, 0.18)',
    muted:        'rgba(180, 200, 220, 0.35)',
    text:         'rgba(210, 230, 240, 0.9)',
    textDim:      'rgba(150, 175, 195, 0.55)',
  },

  // ── Neural Mesh Canvas ──────────────────────────────────────────────────────
  mesh: {
    particleCount:      72,
    particleRadius:     1.6,
    particleSpeed:      0.28,
    connectionDistance: 140,
    lineOpacityMax:     0.22,
    pulseSpeed:         0.0018,
    driftStrength:      0.012,
    mouseRepelRadius:   90,
    mouseRepelForce:    0.055,
    colorParticle:      '#00f5c8',
    colorLine:          '#00f5c8',
    colorPulse:         '#ff9500',
  },

  // ── Card Tilt (3D mouse tracking) ──────────────────────────────────────────
  tilt: {
    maxDeg:        10,
    perspective:   900,
    transitionMs:  180,
    glareOpacity:  0.08,
    scaleOnHover:  1.018,
  },

  // ── Log Card Entry Animation ───────────────────────────────────────────────
  cards: {
    entryDurationMs:  420,
    maxVisible:       40,
    staggerMs:        38,
    slideFromPx:      32,
  },

  // ── Connection Status Ring ─────────────────────────────────────────────────
  ring: {
    orbitDurationMs:  2800,
    pulseDurationMs:  1600,
    dotCount:         3,
  },

  // ── Log Level Styles ───────────────────────────────────────────────────────
  levels: {
    log:   { color: '#00f5c8', label: 'LOG',   dim: 'rgba(0,245,200,0.12)'    },
    info:  { color: '#5eb8ff', label: 'INFO',  dim: 'rgba(94,184,255,0.12)'   },
    warn:  { color: '#ff9500', label: 'WARN',  dim: 'rgba(255,149,0,0.12)'    },
    error: { color: '#ff3b5c', label: 'ERR',   dim: 'rgba(255,59,92,0.12)'    },
    card:  { color: '#bf5fff', label: 'CARD',  dim: 'rgba(191,95,255,0.12)'   },
    sys:   { color: '#5eb8ff', label: 'SYS',   dim: 'rgba(94,184,255,0.10)'   },
  },

  // ── Timing / Intervals ─────────────────────────────────────────────────────
  timing: {
    flushMs:   2000,
    pollMs:    3000,
    statTickMs: 1000,
  },

};
import { ReactNode } from 'react'

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen grid" style={{ gridTemplateColumns: '1fr 1fr' }}>

      {/* ── Left: Brand Panel ── */}
      <div
        className="relative flex flex-col justify-between overflow-hidden"
        style={{
          padding: '52px',
          background: 'linear-gradient(145deg, #0C1B3A 0%, #1A3680 55%, #1D4ED8 100%)',
        }}
      >
        {/* Ambient glow layers */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse at 25% 65%, rgba(14,165,233,0.22) 0%, transparent 55%), ' +
              'radial-gradient(ellipse at 80% 15%, rgba(124,58,237,0.15) 0%, transparent 50%)',
          }}
        />
        <div
          className="absolute pointer-events-none"
          style={{
            bottom: '-80px', right: '-80px',
            width: '360px', height: '360px',
            borderRadius: '50%',
            border: '1px solid rgba(14,165,233,0.12)',
            background: 'radial-gradient(circle, rgba(14,165,233,0.06) 0%, transparent 70%)',
          }}
        />

        {/* Logo */}
        <div className="relative z-10">
          <img
            src="/maxisai-logo-white.png"
            alt="MaxisAI"
            style={{ display: 'block', height: '180px', width: 'auto', objectFit: 'contain', marginLeft: 0 }}
          />
        </div>

        {/* Hero */}
        <div className="relative z-10" style={{ marginLeft: 0 }}>
          <h1
            style={{
              fontSize: '46px',
              fontWeight: 800,
              color: 'white',
              lineHeight: 1.05,
              letterSpacing: '-0.03em',
              marginBottom: '20px',
            }}
          >
            From Protocol<br />to Intelligence.
          </h1>
          <p style={{ fontSize: '15px', color: 'rgba(255,255,255,0.65)', lineHeight: 1.6, maxWidth: '380px' }}>
            AI-powered USDM generation platform · TrialOS Digital Data Flow
            <br /><br />
            Field-level provenance · ICH M11 round-trip · Self-correcting agentic pipeline
          </p>
        </div>

        {/* Badges + Footer */}
        <div className="relative z-10">
          <div className="flex flex-wrap gap-2 mb-4">
            {['AWS Bedrock', 'CDISC USDM v4.0', 'ICH M11', '21 CFR Part 11'].map(badge => (
              <span
                key={badge}
                style={{
                  fontFamily: 'monospace',
                  fontSize: '10px',
                  fontWeight: 600,
                  background: 'rgba(14,165,233,0.15)',
                  color: 'rgba(255,255,255,0.85)',
                  padding: '5px 12px',
                  borderRadius: '9999px',
                  border: '1px solid rgba(14,165,233,0.30)',
                  letterSpacing: '0.03em',
                  whiteSpace: 'nowrap',
                }}
              >
                {badge}
              </span>
            ))}
          </div>
          <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)' }}>
            © 2026 MaxisAI · Precision AI for Life Sciences R&amp;D · v1.0.0
          </p>
        </div>
      </div>

      {/* ── Right: Form Side ── */}
      <div
        className="flex items-center justify-center"
        style={{
          padding: '48px',
          background: '#FFFFFF',
          backgroundImage:
            'radial-gradient(circle at 90% 10%, rgba(14,165,233,0.04) 0%, transparent 50%), ' +
            'radial-gradient(circle at 10% 90%, rgba(124,58,237,0.03) 0%, transparent 50%)',
        }}
      >
        <div className="w-full max-w-sm">
          {children}
        </div>
      </div>

    </div>
  )
}

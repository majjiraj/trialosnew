import type { Metadata } from 'next'
import './globals.css'
import { Providers } from '@/components/layout/Providers'
import { Toaster } from 'sonner'

export const metadata: Metadata = {
  title: 'TrialOS — Clinical Trials AI Platform',
  description: 'The AI operating system for clinical trials',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-surface antialiased">
        <Providers>
          {children}
          <Toaster position="top-right" richColors />
        </Providers>
      </body>
    </html>
  )
}

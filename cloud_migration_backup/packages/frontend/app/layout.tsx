import type { Metadata, Viewport } from 'next'
import { Assistant } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'

const assistant = Assistant({ 
  subsets: ["latin", "hebrew"],
  variable: "--font-assistant"
});

export const metadata: Metadata = {
  title: 'מערכת ניטור תחבורה ציבורית',
  description: 'מערכת לניטור התראות תחבורה ציבורית בישראל',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  themeColor: '#19D3C5',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="he" dir="rtl">
      <body className={`${assistant.variable} font-sans antialiased`}>
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}

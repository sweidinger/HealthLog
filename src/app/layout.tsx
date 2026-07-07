import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { Providers } from "@/components/providers";
import { AuthShell } from "@/components/layout/auth-shell";
import { MonitoringBootstrap } from "@/components/monitoring/bootstrap";
import { WebVitalsReporter } from "@/components/monitoring/web-vitals-reporter";
import { resolveInitialLocale } from "@/lib/i18n/resolve-initial-locale";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "HealthLog",
  description:
    "Self-hosted health tracker — weight, blood pressure, glucose, mood, medications. Withings + Apple Health sync, transparent derived wellness metrics, AI Insights you own.",
  manifest: "/manifest.json",
  icons: {
    icon: "/favicon.svg",
    // Pre-flattened 180×180 on the app background — Safari ignores PNG
    // alpha in favourites/home-screen tiles and would render the
    // transparent logo on a white slab otherwise.
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "HealthLog",
  },
  openGraph: {
    title: "HealthLog",
    description:
      "Self-hosted health tracker. Weight, blood pressure, glucose, mood, medications. Withings + Apple Health sync. AI Insights you own.",
    type: "website",
    locale: "en_US",
    alternateLocale: ["de_DE", "fr_FR", "es_ES", "it_IT", "pl_PL"],
    siteName: "HealthLog",
    // Drop-in OG asset. Replace with a 1200×630 dashboard-screenshot
    // capture when an official one ships; the logo render keeps the
    // unfurl from rendering a blank tile in the meantime.
    images: [
      {
        url: "/logo-readme.png",
        width: 1000,
        height: 1000,
        alt: "HealthLog — your health data, your server",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "HealthLog",
    description:
      "Self-hosted health tracker. Weight, blood pressure, glucose, mood, medications. Withings + Apple Health sync. AI Insights you own.",
    images: ["/logo-readme.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Match the browser chrome (Android URL bar, iOS PWA status bar) to
  // the active palette. The hex values are the resolved background of
  // `--background` from `app/globals.css` for each theme so the bar
  // edge never seams against the page on cold paint.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f2f5" },
    { media: "(prefers-color-scheme: dark)", color: "#282a36" },
  ],
};

// Inline script to apply theme before first paint (prevents FOUC)
const themeScript = `(function(){try{var t=localStorage.getItem("healthlog-theme");var c=(t==="light"||t==="dark")?t:(t==="system"?(window.matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light"):"dark");document.documentElement.classList.add(c)}catch(e){document.documentElement.classList.add("dark")}})()`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce =
    process.env.NODE_ENV === "production"
      ? ((await headers()).get("x-nonce") ?? undefined)
      : undefined;

  const initialLocale = await resolveInitialLocale();

  return (
    <html lang={initialLocale} suppressHydrationWarning>
      <head>
        <script
          suppressHydrationWarning
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: themeScript }}
        />
        {/*
          Locale-catalog boot script (see src/app/i18n/[locale]/route.ts).
          Replaces the former RSC-prop handoff that inlined the whole
          active catalog into every document's flight payload (392 KB of a
          505 KB dashboard HTML). `defer` keeps it off the parse/paint
          critical path while still executing before Next's hydration
          module scripts (both ride the after-parse in-order queue, and
          this tag comes first), so `load-locale.ts` finds `self.__HL_I18N`
          set when the client bundle initializes — SSR text and first
          client render stay identical. The `?v=` build-version key makes
          the response immutable-cacheable: one catalog download per
          deploy, then HTTP/SW cache instead of per-document payload.
        */}
        <script
          src={`/i18n/${initialLocale}?v=${process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}`}
          defer
        />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <Providers initialLocale={initialLocale}>
          <MonitoringBootstrap />
          <WebVitalsReporter />
          {/* `DEMO_MODE` is a server-only env var; the proxy uses it to
              block mutations. Resolve it here (server component) and
              thread the boolean into the client shell so the demo
              banner can render without a client-side detection path. */}
          <AuthShell demoMode={process.env.DEMO_MODE === "true"}>
            {children}
          </AuthShell>
        </Providers>
      </body>
    </html>
  );
}

import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { ExportBanner } from "@/components/export-banner";
import { I18nProvider } from "@/lib/i18n";
import { LibraryProvider } from "@/lib/library";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Nibras Audio" },
      { name: "description", content: "Nibras Audio — offline voice studio for phone recordings, imports, and notes." },
      { name: "theme-color", content: "#050816" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Outfit:wght@400;500;600;700&display=swap",
      },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
    ],
  }),
  component: RootComponent,
});

function OfflineCache() {
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  return null;
}

function RootComponent() {
  return (
    <html lang="az" dir="ltr" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var l=localStorage.getItem('nibras-locale');if(l==='ar'){document.documentElement.lang='ar';document.documentElement.dir='rtl'}else if(l==='en'||l==='az'||l==='tr'||l==='ru'){document.documentElement.lang=l;document.documentElement.dir='ltr'}}catch(e){}",
          }}
        />
      </head>
      <body>
        <PreviewHostBridge />
        <AuthProvider>
          <I18nProvider>
            <LibraryProvider>
              <Outlet />
              <ExportBanner />
              <OfflineCache />
            </LibraryProvider>
          </I18nProvider>
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  );
}

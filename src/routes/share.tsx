import { createFileRoute } from "@tanstack/react-router";
import { HomeScreen } from "@/components/home-screen";

export const Route = createFileRoute("/share")({
  head: () => ({ meta: [{ title: "Səsi paylaş — Nibras Audio" }, { name: "description", content: "Səsi paylaş onlayn, pulsuz, brauzerdə — Nibras Audio." }] }),
  component: () => <HomeScreen focus="share" />,
});

import { createFileRoute } from "@tanstack/react-router";
import { HomeScreen } from "@/components/home-screen";

export const Route = createFileRoute("/fx")({
  head: () => ({ meta: [{ title: "Səs effektləri — Nibras Audio" }, { name: "description", content: "Səs effektləri onlayn, pulsuz, brauzerdə — Nibras Audio." }] }),
  component: () => <HomeScreen focus="fx" />,
});

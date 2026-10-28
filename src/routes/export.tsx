import { createFileRoute } from "@tanstack/react-router";
import { HomeScreen } from "@/components/home-screen";

export const Route = createFileRoute("/export")({
  head: () => ({ meta: [{ title: "Səsi telefona saxla — Nibras Audio" }, { name: "description", content: "Səsi telefona saxla onlayn, pulsuz, brauzerdə — Nibras Audio." }] }),
  component: () => <HomeScreen focus="export" />,
});

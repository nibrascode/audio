import { createFileRoute } from "@tanstack/react-router";
import { HomeScreen } from "@/components/home-screen";

export const Route = createFileRoute("/notes")({
  head: () => ({ meta: [{ title: "Səs qeydləri — Nibras Audio" }, { name: "description", content: "Səs qeydləri onlayn, pulsuz, brauzerdə — Nibras Audio." }] }),
  component: () => <HomeScreen focus="notes" />,
});

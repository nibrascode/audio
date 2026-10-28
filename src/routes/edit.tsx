import { createFileRoute } from "@tanstack/react-router";
import { HomeScreen } from "@/components/home-screen";

export const Route = createFileRoute("/edit")({
  head: () => ({ meta: [{ title: "Səs montajı — Nibras Audio" }, { name: "description", content: "Səs montajı onlayn, pulsuz, brauzerdə — Nibras Audio." }] }),
  component: () => <HomeScreen focus="edit" />,
});

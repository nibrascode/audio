import { createFileRoute } from "@tanstack/react-router";
import { HomeScreen } from "@/components/home-screen";

export const Route = createFileRoute("/mix")({
  head: () => ({ meta: [{ title: "Səs qarışdır — Nibras Audio" }, { name: "description", content: "Səs qarışdır onlayn, pulsuz, brauzerdə — Nibras Audio." }] }),
  component: () => <HomeScreen focus="mix" />,
});

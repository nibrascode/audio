import { createFileRoute } from "@tanstack/react-router";
import { HomeScreen } from "@/components/home-screen";

export const Route = createFileRoute("/open")({
  head: () => ({ meta: [{ title: "Audio fayl aç — Nibras Audio" }, { name: "description", content: "Audio fayl aç onlayn, pulsuz, brauzerdə — Nibras Audio." }] }),
  component: () => <HomeScreen focus="open" />,
});

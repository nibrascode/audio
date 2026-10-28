import { createFileRoute } from "@tanstack/react-router";
import { HomeScreen } from "@/components/home-screen";

export const Route = createFileRoute("/denoise")({
  head: () => ({ meta: [{ title: "Küyü azalt — Nibras Audio" }, { name: "description", content: "Küyü azalt onlayn, pulsuz, brauzerdə — Nibras Audio." }] }),
  component: () => <HomeScreen focus="denoise" />,
});

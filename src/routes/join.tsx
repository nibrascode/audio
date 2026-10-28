import { createFileRoute } from "@tanstack/react-router";
import { HomeScreen } from "@/components/home-screen";

export const Route = createFileRoute("/join")({
  head: () => ({ meta: [{ title: "Səs birləşdir — Nibras Audio" }, { name: "description", content: "Səs birləşdir onlayn, pulsuz, brauzerdə — Nibras Audio." }] }),
  component: () => <HomeScreen focus="join" />,
});

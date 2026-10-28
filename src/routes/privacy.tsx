import { createFileRoute } from "@tanstack/react-router";
import { PrivacyScreen } from "@/components/privacy-screen";

export const Route = createFileRoute("/privacy")({
  component: PrivacyScreen,
});

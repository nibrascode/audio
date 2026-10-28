import { createFileRoute } from "@tanstack/react-router";
import { BatchScreen } from "@/components/batch-screen";

export const Route = createFileRoute("/batch")({
  component: BatchScreen,
});

import { createFileRoute } from "@tanstack/react-router";
import { RecorderScreen } from "@/components/recorder-screen";

export const Route = createFileRoute("/record")({ component: RecorderScreen });

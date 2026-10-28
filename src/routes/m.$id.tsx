import { createFileRoute } from "@tanstack/react-router";
import { MixScreen } from "@/components/mix-screen";

export const Route = createFileRoute("/m/$id")({
  component: MixRoute,
});

function MixRoute() {
  const { id } = Route.useParams();
  return <MixScreen id={id} />;
}

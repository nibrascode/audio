import { createFileRoute } from "@tanstack/react-router";
import { ProjectScreen } from "@/components/project-screen";

export const Route = createFileRoute("/p/$id")({
  component: ProjectRoute,
});

function ProjectRoute() {
  const { id } = Route.useParams();
  return <ProjectScreen id={id} />;
}

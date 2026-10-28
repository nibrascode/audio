import { createFileRoute } from "@tanstack/react-router";
import { EditorScreen } from "@/components/editor-screen";

export const Route = createFileRoute("/e/$id")({
  component: EditorRoute,
});

function EditorRoute() {
  const { id } = Route.useParams();
  return <EditorScreen id={id} />;
}

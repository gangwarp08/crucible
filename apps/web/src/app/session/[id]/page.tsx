import WorkspaceLoader from "@/components/workspace/WorkspaceLoader";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function SessionPage({ params }: Props) {
  const { id } = await params;
  return <WorkspaceLoader sessionId={id} />;
}

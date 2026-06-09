import WorkspaceLoader from "@/components/workspace/WorkspaceLoader";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function SessionPage({ params }: Props) {
  const { id } = await params;
  // key={id} forces a full remount when navigating between sessions in the
  // same tab — guarantees React tears down the prior Workspace's subtree
  // (PTY WS, messaging WS, all useEffects) before mounting fresh for the
  // new session. Belt-and-suspenders alongside the eager store reset in
  // Workspace's mount useEffect.
  return <WorkspaceLoader sessionId={id} key={id} />;
}

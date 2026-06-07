"use client";
import dynamic from "next/dynamic";

const Workspace = dynamic(() => import("./Workspace"), { ssr: false });

export default function WorkspaceLoader({ sessionId }: { sessionId: string }) {
  return <Workspace sessionId={sessionId} />;
}

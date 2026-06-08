import SessionDetailLoader from "@/components/review/SessionDetailLoader";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ReviewSessionPage({ params }: Props) {
  const { id } = await params;
  return <SessionDetailLoader id={id} />;
}

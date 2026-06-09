import StartScreen from "@/components/start/StartScreen";

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function StartPage({ params }: Props) {
  const { slug } = await params;
  return <StartScreen slug={slug} />;
}

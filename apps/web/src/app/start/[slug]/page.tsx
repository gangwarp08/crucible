import StartScreen from "@/components/start/StartScreen";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function StartPage({ params, searchParams }: Props) {
  const { slug } = await params;
  // RD6/P5.1: recruiters hand out /start/<slug>?link=<token>. Read the token
  // here (server component) instead of useSearchParams in the client — no
  // Suspense boundary needed and the client component stays static.
  const { link } = await searchParams;
  const linkToken = typeof link === "string" && link.length > 0 ? link : null;
  return <StartScreen slug={slug} linkToken={linkToken} />;
}

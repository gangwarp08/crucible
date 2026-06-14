import ScenariosCatalog from "@/components/start/ScenariosCatalog";

// Candidate-facing catalog page. Lists every scenario in the platform
// at a metadata level (title, role, difficulty). The brief and the rest
// of the scenario IP stay invite-gated on /start/[slug].
export default function ScenariosPage(): React.ReactElement {
  return <ScenariosCatalog />;
}

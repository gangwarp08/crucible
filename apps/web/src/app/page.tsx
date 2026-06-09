import { redirect } from "next/navigation";

// Single-scenario world for now — root redirects straight to the canonical
// start page. When a second scenario lands this becomes a catalog UI.
export default function HomePage(): never {
  redirect("/start/fde-db-triage");
}

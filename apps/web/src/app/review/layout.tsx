import type { ReactNode } from "react";
import OrgKeyBootstrap from "@/components/review/OrgKeyBootstrap";

// Shared layout for the whole review surface (/review, /review/[id],
// /review/cohorts/*): mounts the ?key= → sessionStorage bootstrap ahead of the
// page so link-embedded partner access works on every review route.
export default function ReviewLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <OrgKeyBootstrap />
      {children}
    </>
  );
}

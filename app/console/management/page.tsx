import type { Metadata } from "next";
import ConsoleShell from "@/components/console/ConsoleShell";
import ConsoleManagementClient from "@/components/console/ConsoleManagementClientV2";

// noindex/nofollow — this route must never appear in search results or
// be crawled. Middleware already blocks unauthorized access at the
// network level; this just keeps it out of sitemaps/search engines too.
export const metadata: Metadata = {
  title: "Staff Console",
  robots: { index: false, follow: false, nocache: true },
};

export default function ConsoleManagementPage() {
  return (
    <ConsoleShell>
      {({ openNav }) => <ConsoleManagementClient onOpenMore={openNav} />}
    </ConsoleShell>
  );
}

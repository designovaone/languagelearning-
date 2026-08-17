import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

const withNextIntl = createNextIntlPlugin("./lib/i18n/request.ts");

const nextConfig: NextConfig = {
  // Functions run in fra1 with the database in eu-central-1 (PLAN.md §13).
  // Node runtime everywhere: the proxy convention has no edge runtime, and
  // web-push needs Node.
  serverExternalPackages: ["@neondatabase/serverless"],
};

export default withNextIntl(nextConfig);

import { requireUser } from "@/lib/auth/session";

/**
 * Everything under (app) requires a session. Putting the gate in the layout
 * means a new page cannot forget it — the failure mode of per-page checks is a
 * page that silently has none.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  await requireUser();
  return <div className="mx-auto w-full max-w-md px-5 py-8">{children}</div>;
}

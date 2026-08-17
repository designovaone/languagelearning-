import { requireApiUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { exportUserData } from "@/lib/gdpr/export";
import { systemClock } from "@/lib/time/clock";

/** GDPR Art. 15. Everything this app knows about the caller, as JSON. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { user, response } = await requireApiUser();
  if (response) return response;

  const dump = await exportUserData(getDb(), user.id, systemClock.now());

  return new Response(JSON.stringify(dump, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="my-data.json"`,
      // An export must never sit in a shared cache.
      "cache-control": "no-store, private",
    },
  });
}

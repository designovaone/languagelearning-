import { requireApiUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { hardDeleteUser } from "@/lib/gdpr/export";

/** GDPR Art. 17. Irreversible: the review history goes with the account. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request) {
  const { user, response } = await requireApiUser();
  if (response) return response;

  // A destructive endpoint should not fire on a stray fetch. The caller has to
  // say what it is deleting.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const confirmed =
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>).confirm === user.email;

  if (!confirmed) {
    return Response.json(
      { error: "confirmation-required" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const deleted = await hardDeleteUser(getDb(), user.id);
  return Response.json(
    { deleted },
    { status: deleted ? 200 : 404, headers: { "cache-control": "no-store" } },
  );
}

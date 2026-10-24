import { redirect } from "next/navigation";

// see dashboard/page.tsx's comment on this export
export const instant = false;

export default function AdminPage() {
  redirect("/dashboard/admin/audit");
}

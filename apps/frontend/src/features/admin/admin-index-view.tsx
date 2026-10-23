import Link from "next/link";
import { ArrowRight, CreditCard, ScrollText, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const SECTIONS = [
  {
    href: "/dashboard/admin/audit",
    icon: ScrollText,
    title: "Audit log",
    description: "Review admin actions taken across the app.",
  },
  {
    href: "/dashboard/admin/purchases",
    icon: CreditCard,
    title: "Purchases",
    description: "Look up and manage customer purchases.",
  },
  {
    href: "/dashboard/admin/users",
    icon: Users,
    title: "Users",
    description: "Browse accounts, roles, and verification status.",
  },
];

export function AdminIndexView() {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {SECTIONS.map(({ href, icon: Icon, title, description }) => (
        <Link key={href} href={href} className="group">
          <Card className="h-full transition-colors group-hover:ring-foreground/20">
            <CardHeader>
              <Icon className="mb-2 size-5 text-muted-foreground" />
              <CardTitle className="flex items-center justify-between">
                {title}
                <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription>{description}</CardDescription>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}

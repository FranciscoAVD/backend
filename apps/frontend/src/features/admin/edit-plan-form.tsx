"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { apiClient } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";

async function fetchPlan(id: string) {
  const res = await apiClient.api.payments.plans[":id"].$get({ param: { id } });

  if (!res.ok) {
    const body = await res.json();
    throw new Error("message" in body ? body.message : "Failed to load plan");
  }

  return res.json();
}

type Plan = Awaited<ReturnType<typeof fetchPlan>>["data"];

type PlanUpdate = {
  active?: boolean;
  repeatable?: boolean;
  overlapping?: boolean;
  trialDays?: number | null;
  durationDays?: number | null;
  limits?: Record<string, unknown> | null;
};

async function updatePlan(id: number, data: PlanUpdate) {
  const res = await apiClient.api.payments.plans[":id"].$patch({
    param: { id: String(id) },
    json: data,
  });

  if (!res.ok) {
    const body = await res.json();
    throw new Error("message" in body ? body.message : "Failed to update plan");
  }
}

export function EditPlanForm() {
  const { id } = useParams<{ id: string }>();

  const { data, error, isPending } = useQuery({
    queryKey: ["admin", "plans", id],
    queryFn: () => fetchPlan(id),
  });

  if (isPending) return <p className="text-sm text-muted-foreground">Loading plan...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  return <EditPlanFields plan={data.data} />;
}

function EditPlanFields({ plan }: { plan: Plan }) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [active, setActive] = useState(plan.active);
  const [repeatable, setRepeatable] = useState(plan.repeatable);
  const [overlapping, setOverlapping] = useState(plan.overlapping);
  const [trialDays, setTrialDays] = useState(plan.trialDays != null ? String(plan.trialDays) : "");
  const [durationDays, setDurationDays] = useState(
    plan.durationDays != null ? String(plan.durationDays) : "",
  );
  const [limitsText, setLimitsText] = useState(
    plan.limits != null ? JSON.stringify(plan.limits, null, 2) : "",
  );
  const [limitsError, setLimitsError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: (data: PlanUpdate) => updatePlan(plan.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "plans"] });
      router.push("/dashboard/admin/plans");
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setLimitsError(null);

    let limits: Record<string, unknown> | null = null;
    if (limitsText.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(limitsText);
      } catch {
        setLimitsError("Limits must be valid JSON.");
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setLimitsError("Limits must be a JSON object.");
        return;
      }
      limits = parsed as Record<string, unknown>;
    }

    update.mutate({
      active,
      ...(plan.type === "one_time" ? { repeatable, overlapping } : {}),
      ...(plan.type === "recurring" ? { trialDays: trialDays ? Number(trialDays) : null } : {}),
      ...(plan.type === "one_time"
        ? { durationDays: durationDays ? Number(durationDays) : null }
        : {}),
      limits,
    });
  };

  return (
    <form onSubmit={onSubmit} className="max-w-xl rounded-lg border border-border p-4">
      <FieldGroup>
        <p className="text-sm font-medium">Editing {plan.name}</p>
        <Field orientation="horizontal">
          <Checkbox id="edit-active" checked={active} onCheckedChange={setActive} />
          <FieldLabel htmlFor="edit-active">Active</FieldLabel>
        </Field>
        {plan.type === "one_time" && (
          <>
            <Field orientation="horizontal">
              <Checkbox id="edit-repeatable" checked={repeatable} onCheckedChange={setRepeatable} />
              <FieldLabel htmlFor="edit-repeatable">Repeatable</FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <Checkbox id="edit-overlapping" checked={overlapping} onCheckedChange={setOverlapping} />
              <FieldLabel htmlFor="edit-overlapping">Overlapping</FieldLabel>
            </Field>
            <Field orientation="responsive">
              <FieldLabel htmlFor="edit-duration-days">Duration days</FieldLabel>
              <Input
                id="edit-duration-days"
                type="number"
                min="1"
                value={durationDays}
                onChange={(e) => setDurationDays(e.target.value)}
              />
            </Field>
          </>
        )}
        {plan.type === "recurring" && (
          <Field orientation="responsive">
            <FieldLabel htmlFor="edit-trial-days">Trial days</FieldLabel>
            <Input
              id="edit-trial-days"
              type="number"
              min="1"
              value={trialDays}
              onChange={(e) => setTrialDays(e.target.value)}
            />
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="edit-limits">Limits (JSON object, blank for none)</FieldLabel>
          <textarea
            id="edit-limits"
            rows={4}
            className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            value={limitsText}
            onChange={(e) => setLimitsText(e.target.value)}
          />
          {limitsError && <FieldError>{limitsError}</FieldError>}
        </Field>
        {update.error && <FieldError>{update.error.message}</FieldError>}
        <div className="flex gap-2">
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? "Saving..." : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push("/dashboard/admin/plans")}
          >
            Cancel
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

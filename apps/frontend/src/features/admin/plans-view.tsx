"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { formatAmount } from "@/lib/currency";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

async function fetchPlans() {
  const res = await apiClient.api.payments.plans.$get();

  if (!res.ok) {
    const body = await res.json();
    throw new Error("message" in body ? body.message : "Failed to load plans");
  }

  return res.json();
}

type Plan = Awaited<ReturnType<typeof fetchPlans>>["data"][number];

type PlanInsert = {
  name: string;
  type: "recurring" | "one_time";
  amount: number;
  currency: string;
  annualAmount: number | null;
  trialDays: number | null;
  durationDays: number | null;
  interval?: "month" | "year" | null;
  repeatable?: boolean;
  overlapping?: boolean;
};

async function createPlan(data: PlanInsert) {
  // The backend's jsonValidator returns `{ data }` from c.req.valid("json"), which hc's RPC type
  // inference mistakes for the wire body shape. The actual request body the validator parses is
  // `data` unwrapped (confirmed against payments/tests/route.test.ts's raw request bodies) - the
  // `{ data }` shape is only how the *parsed result* is exposed inside the handler.
  const res = await apiClient.api.payments.plans.$post({ json: data as never });

  if (!res.ok) {
    const body = await res.json();
    throw new Error("message" in body ? body.message : "Failed to create plan");
  }

  return res.json();
}

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
    // see createPlan's comment: the wire body is `data` unwrapped, not `{ data }`
    json: data as never,
  });

  if (!res.ok) {
    const body = await res.json();
    throw new Error("message" in body ? body.message : "Failed to update plan");
  }
}

export function PlansView() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const { data, error, isPending } = useQuery({
    queryKey: ["admin", "plans"],
    queryFn: fetchPlans,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin", "plans"] });

  if (isPending) return <p className="text-sm text-muted-foreground">Loading plans...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  const plans = data.data;
  const editingPlan = plans.find((plan) => plan.id === editingId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={() => setCreating((c) => !c)}>
          {creating ? "Cancel" : "New plan"}
        </Button>
      </div>
      {creating && (
        <CreatePlanForm
          onCreated={() => {
            setCreating(false);
            invalidate();
          }}
        />
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Active</TableHead>
            <TableHead>Repeatable</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Trial</TableHead>
            <TableHead>Overlapping</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {plans.length === 0 ? (
            <TableRow>
              <TableCell colSpan={9} className="text-center text-muted-foreground">
                No plans
              </TableCell>
            </TableRow>
          ) : (
            plans.map((plan) => (
              <TableRow key={plan.id}>
                <TableCell className="font-medium">{plan.name}</TableCell>
                <TableCell>
                  {plan.type === "recurring" ? `recurring/${plan.interval}` : "one-time"}
                </TableCell>
                <TableCell>{formatAmount(plan.amount, plan.currency)}</TableCell>
                <TableCell>
                  <Badge variant={plan.active ? "default" : "secondary"}>
                    {plan.active ? "Active" : "Inactive"}
                  </Badge>
                </TableCell>
                <TableCell>
                  {plan.type === "one_time" ? (plan.repeatable ? "Yes" : "No") : "—"}
                </TableCell>
                <TableCell>{plan.durationDays ?? "—"}</TableCell>
                <TableCell>{plan.trialDays ?? "—"}</TableCell>
                <TableCell>
                  {plan.type === "one_time" ? (plan.overlapping ? "Yes" : "No") : "—"}
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditingId(editingId === plan.id ? null : plan.id)}
                  >
                    {editingId === plan.id ? "Close" : "Edit"}
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {editingPlan && (
        <EditPlanForm
          plan={editingPlan}
          onUpdated={() => {
            setEditingId(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function CreatePlanForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [planType, setPlanType] = useState<"recurring" | "one_time">("one_time");
  const [amountInput, setAmountInput] = useState("");
  const [currency, setCurrency] = useState("usd");
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [annualAmountInput, setAnnualAmountInput] = useState("");
  const [trialDays, setTrialDays] = useState("");
  const [repeatable, setRepeatable] = useState(false);
  const [durationDays, setDurationDays] = useState("");
  const [overlapping, setOverlapping] = useState(true);

  const create = useMutation({
    mutationFn: createPlan,
    onSuccess: onCreated,
  });

  const toMinorUnits = (value: string) => Math.round(parseFloat(value) * 100);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const base: PlanInsert = {
      name,
      type: planType,
      amount: toMinorUnits(amountInput),
      currency: currency.trim().toLowerCase(),
      annualAmount:
        planType === "recurring" && annualAmountInput ? toMinorUnits(annualAmountInput) : null,
      trialDays: planType === "recurring" && trialDays ? Number(trialDays) : null,
      durationDays: planType === "one_time" && durationDays ? Number(durationDays) : null,
    };
    create.mutate(
      planType === "recurring" ? { ...base, interval } : { ...base, repeatable, overlapping },
    );
  };

  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-border p-4">
      <FieldGroup>
        <Field orientation="responsive">
          <FieldLabel htmlFor="plan-name">Name</FieldLabel>
          <Input id="plan-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field orientation="responsive">
          <FieldLabel htmlFor="plan-type">Type</FieldLabel>
          <Select
            value={planType}
            onValueChange={(value) => value && setPlanType(value)}
          >
            <SelectTrigger id="plan-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="one_time">One-time</SelectItem>
              <SelectItem value="recurring">Recurring</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field orientation="responsive">
          <FieldLabel htmlFor="plan-amount">Amount (major units, e.g. 9.99)</FieldLabel>
          <Input
            id="plan-amount"
            type="number"
            step="0.01"
            min="0.01"
            required
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
          />
        </Field>
        <Field orientation="responsive">
          <FieldLabel htmlFor="plan-currency">Currency</FieldLabel>
          <Input
            id="plan-currency"
            required
            maxLength={3}
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          />
        </Field>
        {planType === "recurring" ? (
          <>
            <Field orientation="responsive">
              <FieldLabel htmlFor="plan-interval">Interval</FieldLabel>
              <Select
                value={interval}
                onValueChange={(value) => value && setInterval(value)}
              >
                <SelectTrigger id="plan-interval">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="month">Month</SelectItem>
                  <SelectItem value="year">Year</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field orientation="responsive">
              <FieldLabel htmlFor="plan-annual-amount">Annual price (optional)</FieldLabel>
              <Input
                id="plan-annual-amount"
                type="number"
                step="0.01"
                min="0"
                value={annualAmountInput}
                onChange={(e) => setAnnualAmountInput(e.target.value)}
              />
            </Field>
            <Field orientation="responsive">
              <FieldLabel htmlFor="plan-trial-days">Trial days (optional)</FieldLabel>
              <Input
                id="plan-trial-days"
                type="number"
                min="1"
                value={trialDays}
                onChange={(e) => setTrialDays(e.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <Field orientation="horizontal">
              <Checkbox id="plan-repeatable" checked={repeatable} onCheckedChange={setRepeatable} />
              <FieldLabel htmlFor="plan-repeatable">Repeatable</FieldLabel>
            </Field>
            <Field orientation="responsive">
              <FieldLabel htmlFor="plan-duration-days">Duration days (optional)</FieldLabel>
              <Input
                id="plan-duration-days"
                type="number"
                min="1"
                value={durationDays}
                onChange={(e) => setDurationDays(e.target.value)}
              />
            </Field>
            <Field orientation="horizontal">
              <Checkbox id="plan-overlapping" checked={overlapping} onCheckedChange={setOverlapping} />
              <FieldLabel htmlFor="plan-overlapping">Overlapping</FieldLabel>
            </Field>
          </>
        )}
        {create.error && <FieldError>{create.error.message}</FieldError>}
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating..." : "Create plan"}
        </Button>
      </FieldGroup>
    </form>
  );
}

function EditPlanForm({ plan, onUpdated }: { plan: Plan; onUpdated: () => void }) {
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
    onSuccess: onUpdated,
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
    <form onSubmit={onSubmit} className="rounded-lg border border-border p-4">
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
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? "Saving..." : "Save"}
        </Button>
      </FieldGroup>
    </form>
  );
}

"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api-client";
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
  const res = await apiClient.api.payments.plans.$post({ json: data });

  if (!res.ok) {
    const body = await res.json();
    throw new Error("message" in body ? body.message : "Failed to create plan");
  }

  return res.json();
}

export function CreatePlanForm() {
  const router = useRouter();
  const queryClient = useQueryClient();

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "plans"] });
      router.push("/dashboard/admin/plans");
    },
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
    <form onSubmit={onSubmit} className="max-w-xl rounded-lg border border-border p-4">
      <FieldGroup>
        <Field orientation="responsive">
          <FieldLabel htmlFor="plan-name">Name</FieldLabel>
          <Input id="plan-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field orientation="responsive">
          <FieldLabel htmlFor="plan-type">Type</FieldLabel>
          <Select value={planType} onValueChange={(value) => value && setPlanType(value)}>
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
              <Select value={interval} onValueChange={(value) => value && setInterval(value)}>
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
        <div className="flex gap-2">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating..." : "Create plan"}
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

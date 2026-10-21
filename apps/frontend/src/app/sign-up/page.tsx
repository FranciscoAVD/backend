import { SignUpForm } from "@/features/auth/sign-up-form";

export default function SignUpPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-2xl font-semibold">Sign up</h1>
        <SignUpForm />
        <p className="text-sm">
          Already have an account?{" "}
          <a href="/sign-in" className="font-medium underline">
            Sign in
          </a>
        </p>
      </div>
    </div>
  );
}

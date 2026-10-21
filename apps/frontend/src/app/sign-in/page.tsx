import { SignInForm } from "@/features/auth/sign-in-form";

export default function SignInPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <SignInForm />
        <p className="text-sm">
          No account?{" "}
          <a href="/sign-up" className="font-medium underline">
            Sign up
          </a>
        </p>
      </div>
    </div>
  );
}

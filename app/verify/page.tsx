export default function VerifyPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-16">
      <h1 className="text-2xl font-semibold">Verify your PayPal account</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Log in with PayPal once so payouts go only to the account you control.
        We receive your PayPal account ID, verified status, name and email.
      </p>
      {/* Plain anchor, not <Link>, so the redirect is never prefetched. */}
      <a
        href="/api/auth/paypal/login"
        className="flex h-12 items-center justify-center rounded-full bg-[#0070ba] px-5 font-medium text-white transition-colors hover:bg-[#005ea6]"
      >
        Log in with PayPal
      </a>
    </main>
  );
}

import { LoginForm } from "@/components/forms"

export default function LoginPage() {
  return (
    <main style={{ maxWidth: 420 }}>
      <h1>letterflow</h1>
      <p className="muted">Briefakquise: Kampagnen, Freigaben und angebundene Systeme.</p>
      <LoginForm />
    </main>
  )
}
